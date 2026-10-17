import { deriveKChain, keyframeFactoryAbi, payoutAt, Status, type Terms } from "@keyframe/protocol";
import { encodeFunctionData, type Hex } from "viem";
import { isTerminal, type OrderEvent, type OrderView } from "../chain.js";
import type { OrderRow, PendingKind, QuoteRow } from "../db/rows.js";
import { termsOf } from "../quotes/view.js";
import { errorText } from "../redact.js";
import type { RelayResult } from "../relayer/types.js";
import { nowS, type Services } from "../services.js";
import { termsTuple } from "../x402/facilitator.js";

// Post-funding state machine. The chain is the source of truth: after any confirmed or failed action the order
// row is re-derived from factory.order(termsHash). Each order has one in-flight action slot (claimPending), so
// the request path (waitUntil) and the cron keeper never send the same transaction twice.

export const RELEASE_GRACE_S = 3 * 86_400;
const SLOT_STALE_S = 300;
/** Safety margin so `charge <= payoutAt(T, block.timestamp)` still holds when the tx lands a little later. */
const PAYOUT_MARGIN_S = 60;
/**
 * No release is sent this close to the last second it is valid (Instant: T.deadline; Studio: review end + grace):
 * a release that lands late reverts after K_chain was already shown to the RPC and the mempool.
 */
export const RELEASE_SAFETY_S = 120;

/**
 * Studio policy after a "changes" request: Keyframe never releases on silence. The studio may deliver one revision
 * (tracked off-chain; the contract knows one deliver), payment is released only on the buyer's explicit accept,
 * and without an accept the keeper refunds the buyer after review end + RELEASE_GRACE_S. The buyer can accept or
 * reject until `acceptBy` (on-chain inside the review window, verified off-chain after it).
 */
export const studioWindows = (o: Pick<OrderRow, "delivered_at">, t: Pick<Terms, "reviewWindow">) => {
  const reviewEnd = (o.delivered_at ?? 0) + t.reviewWindow;
  const graceEnd = reviewEnd + RELEASE_GRACE_S;
  return { reviewEnd, graceEnd, acceptBy: graceEnd - RELEASE_SAFETY_S - 600 };
};

export const CHANGES_POLICY =
  "After a change request Keyframe never releases payment on silence: the studio may deliver one revision, payment is released only when you explicitly accept, and if you do not accept by accept_by the keeper refunds you in full after the release grace period.";

type Patch = Partial<OrderRow>;

const TX_FIELD: Partial<Record<PendingKind, keyof OrderRow>> = {
  release: "release_tx",
  refund: "refund_tx",
  cancel: "cancel_tx",
  deliver: "deliver_tx",
  decide: "decision_tx",
};

/** Map the factory's view of T onto the order row. */
export function patchFromChain(v: OrderView): Patch {
  switch (v.status) {
    case Status.Open:
      return { status: "sealed", registered: 1, funding: "confirmed" };
    case Status.Delivered:
      return {
        status: "delivered",
        registered: 1,
        funding: "confirmed",
        delivered_at: Number(v.deliveredAt),
        accepted: v.accepted ? 1 : 0,
        manifest_hash: v.manifestHash.toLowerCase(),
      };
    case Status.Released:
      return {
        status: "key_published",
        registered: 1,
        to_seller: v.toSeller.toString(),
        to_buyer: v.toBuyer.toString(),
      };
    case Status.Refunded:
    case Status.Rejected:
      return { status: "returned", registered: 1, to_seller: v.toSeller.toString(), to_buyer: v.toBuyer.toString() };
    case Status.Cancelled:
      return { status: "void", registered: 1, to_seller: "0", to_buyer: v.toBuyer.toString() };
    default:
      return {};
  }
}

/** Event whose transaction belongs in a terminal order's *_tx field, when we did not send it ourselves. */
const TERMINAL_EVENT: Partial<Record<number, [OrderEvent, keyof OrderRow]>> = {
  [Status.Released]: ["Released", "release_tx"],
  [Status.Refunded]: ["Refunded", "refund_tx"],
  [Status.Cancelled]: ["Cancelled", "cancel_tx"],
  [Status.Rejected]: ["Decided", "decision_tx"],
};

async function chainPatch(s: Services, order: OrderRow, seen?: OrderView): Promise<Patch> {
  if (!s.chain) return {};
  try {
    const v = seen ?? (await s.chain.orderOf(s.cfg.factory, order.terms_hash as Hex));
    const patch = patchFromChain(v);
    // Someone else (buyer, refundExpired, KeeperHub) finished the order: fill the tx from the factory's event.
    const ev = isTerminal(v.status) ? TERMINAL_EVENT[v.status] : undefined;
    if (ev && !order[ev[1]]) {
      const tx = await s.chain.eventTx(s.cfg.factory, ev[0], order.terms_hash as Hex).catch(() => null);
      if (tx) (patch as Record<string, unknown>)[ev[1]] = tx;
    }
    return patch;
  } catch (e) {
    s.log.warn("chain_read_failed", { order_id: order.id, error: errorText(e, 120) });
    return {};
  }
}

export interface ActionResult {
  state: RelayResult["state"] | "busy";
  hash?: Hex;
  reason?: string;
}

/** Run one relayed factory call for an order under its action slot. */
export async function runAction(
  s: Services,
  order: OrderRow,
  kind: PendingKind,
  data: Hex,
  waitMs: number,
  extra: Patch = {},
): Promise<ActionResult> {
  const now = nowS(s);
  if (!(await s.repo.claimPending(order.id, kind, now, now - SLOT_STALE_S))) return { state: "busy" };
  let r: RelayResult;
  try {
    r = await s.relayer.send({ kind, ref: order.id, data, waitMs });
  } catch (e) {
    r = { state: "unavailable", reason: errorText(e, 120) };
  }
  const field = TX_FIELD[kind];
  const txPatch: Patch = "hash" in r && field ? { [field]: r.hash } : {};
  switch (r.state) {
    case "pending":
      await s.repo.updateOrder(order.id, { ...extra, ...txPatch }, nowS(s));
      await s.repo.setPendingTx(order.id, kind, r.hash, nowS(s));
      return { state: "pending", hash: r.hash };
    case "confirmed":
      // The order with our tx already set: chainPatch then never looks the tx up from events.
      await s.repo.finishPending(
        order.id,
        kind,
        { ...extra, last_error: null, ...(await chainPatch(s, { ...order, ...txPatch })), ...txPatch },
        nowS(s),
      );
      s.log.info("order_action_confirmed", { order_id: order.id, kind, tx: r.hash });
      return { state: "confirmed", hash: r.hash };
    case "reverted":
    case "rejected":
    case "unavailable": {
      const reason = errorText(r.reason, 200);
      // A revert usually means someone else already moved the order on-chain (keeper, buyer, KeeperHub).
      const sync = r.state === "unavailable" ? {} : await chainPatch(s, order);
      await s.repo.finishPending(order.id, kind, { last_error: `${kind}: ${reason}`.slice(0, 300), ...sync }, nowS(s));
      s.log.warn("order_action_failed", { order_id: order.id, kind, state: r.state, reason });
      return { state: r.state, reason, ...("hash" in r ? { hash: r.hash } : {}) };
    }
  }
}

/** Resolve an action whose receipt was still pending when it was sent. */
async function reconcilePending(s: Services, order: OrderRow): Promise<OrderRow | null> {
  if (!order.pending_kind || !order.pending_tx) return order;
  const r = await s.relayer.receipt(order.pending_tx as Hex, 0);
  const now = nowS(s);
  if (r.state === "pending" || r.state === "unknown") {
    if (r.state === "unknown" && order.pending_since !== null && now - order.pending_since > SLOT_STALE_S) {
      await s.repo.finishPending(
        order.id,
        order.pending_kind,
        { last_error: "pending tx unknown to relayer", ...(await chainPatch(s, order)) },
        now,
      );
      return null;
    }
    return null; // still in flight
  }
  const patch: Patch =
    r.state === "confirmed"
      ? { last_error: null, ...(await chainPatch(s, order)) }
      : { last_error: `${order.pending_kind}: ${r.reason}`, ...(await chainPatch(s, order)) };
  await s.repo.finishPending(order.id, order.pending_kind, patch, now);
  return s.repo.getOrder(order.id);
}

const enc = {
  register: (t: Terms) =>
    encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "register", args: [termsTuple(t)] }),
  refund: (t: Terms) => encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "refund", args: [termsTuple(t)] }),
  cancel: (t: Terms) => encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "cancel", args: [termsTuple(t)] }),
  deliver: (t: Terms, manifestHash: Hex) =>
    encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "deliver", args: [termsTuple(t), manifestHash] }),
  release: (t: Terms, key: Hex, charge: bigint, manifestHash: Hex) =>
    encodeFunctionData({
      abi: keyframeFactoryAbi,
      functionName: "release",
      args: [termsTuple(t), key, charge, manifestHash],
    }),
  decideBySig: (t: Terms, accept: boolean, sigDeadline: bigint, signature: Hex) =>
    encodeFunctionData({
      abi: keyframeFactoryAbi,
      functionName: "decideBySig",
      args: [termsTuple(t), accept, sigDeadline, signature],
    }),
  refundExpired: (maxScan: number) =>
    encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "refundExpired", args: [BigInt(maxScan)] }),
};
export const encodeFactoryCall = enc;

/** One step of the post-funding state machine. Idempotent; safe to call from any path at any time. */
export async function advanceOrder(s: Services, orderIn: OrderRow, waitMs: number): Promise<void> {
  let order: OrderRow | null = orderIn;
  if (order.pending_kind) {
    if (order.pending_tx) {
      order = await reconcilePending(s, order);
      if (!order || order.pending_kind) return;
    } else if (nowS(s) - (order.pending_since ?? 0) <= SLOT_STALE_S) {
      return; // another path holds the slot and is about to broadcast
    }
    // else: a slot abandoned before broadcast; runAction below reclaims it
  }
  const quote = await s.repo.getQuote(order.quote_id);
  if (!quote) return;
  const t = termsOf(quote);
  const now = nowS(s);

  switch (order.status) {
    case "funding":
      await confirmFunding(s, order, waitMs);
      return;
    case "sealed":
      if (!order.registered) {
        await ensureRegistered(s, order, t, now, waitMs);
        return;
      }
      if (now > order.deadline) {
        await runAction(s, order, "refund", enc.refund(t), waitMs);
        return;
      }
      if (order.tier === "instant") await releaseInstant(s, order, quote, t, now, waitMs);
      return;
    case "delivered": {
      const deliveredAt = order.delivered_at ?? 0;
      const { reviewEnd, graceEnd } = studioWindows(order, t);
      if (now > graceEnd) {
        await runAction(s, order, "refund", enc.refund(t), waitMs);
        return;
      }
      // After a change request silence never counts as accept: only the buyer's explicit accept releases.
      const changes = order.change_requested_at !== null && order.change_requested_at !== undefined;
      const explicit = order.accepted === 1 || (order.buyer_accepted_at ?? null) !== null;
      const due = changes
        ? explicit && (order.accepted === 1 || now >= reviewEnd)
        : order.accepted === 1 || now >= reviewEnd;
      if (due && now <= graceEnd - RELEASE_SAFETY_S) await releaseStudio(s, order, quote, t, deliveredAt, waitMs);
      return;
    }
    case "failed":
      await refundStranded(s, order, t, now, waitMs);
      return;
    default:
      return;
  }
}

async function confirmFunding(s: Services, order: OrderRow, waitMs: number): Promise<void> {
  const r = await s.relayer.receipt(order.funding_tx as Hex, waitMs);
  const now = nowS(s);
  if (r.state === "confirmed") {
    const patch = await chainPatch(s, order);
    await s.repo.updateOrder(order.id, { funding: "confirmed", status: "sealed", ...patch }, now);
    const next = await s.repo.getOrder(order.id);
    if (next) await advanceOrder(s, next, waitMs);
  } else if (r.state === "reverted") {
    // "Reverted" can be a false "dropped" from a lagging load-balanced node: the chain decides, not the receipt.
    const funded = await fundedOnChain(s, order);
    if (funded === null) return; // could not read: try again on the next pass
    if (funded) {
      s.log.warn("funding_receipt_contradicted", { order_id: order.id, tx: order.funding_tx, reason: r.reason });
      await s.repo.updateOrder(order.id, { funding: "confirmed", status: "sealed", ...funded, last_error: null }, now);
      const next = await s.repo.getOrder(order.id);
      if (next) await advanceOrder(s, next, waitMs);
      return;
    }
    // Nothing moved. The authorization may still be executed by a third party (only into E), so a failed order
    // keeps being watched until its deadline for stranded funds.
    await s.repo.updateOrder(order.id, { status: "failed", last_error: `funding: ${errorText(r.reason, 200)}` }, now);
    s.log.warn("funding_failed", { order_id: order.id, tx: order.funding_tx });
  }
}

/** Registered on-chain (patch from order()), funds at E awaiting register (registered 0), not funded, or unknown. */
async function fundedOnChain(s: Services, order: OrderRow): Promise<Patch | false | null> {
  if (!s.chain) return null;
  try {
    const v = await s.chain.orderOf(s.cfg.factory, order.terms_hash as Hex);
    if (v.status !== Status.None) return patchFromChain(v);
    const bal = await s.chain.balanceOf(s.cfg.usdc, order.escrow as Hex);
    return bal >= BigInt(order.amount) ? { registered: 0 } : false;
  } catch (e) {
    s.log.warn("chain_read_failed", { order_id: order.id, error: errorText(e, 120) });
    return null;
  }
}

async function ensureRegistered(s: Services, order: OrderRow, t: Terms, now: number, waitMs: number) {
  const patch = await chainPatch(s, order);
  if (patch.registered) {
    await s.repo.updateOrder(order.id, patch, now);
    return;
  }
  if (now > order.deadline) {
    // Unregistered T can still be refunded after the deadline (frozen §3); no need to register first.
    await runAction(s, order, "refund", enc.refund(t), waitMs);
    return;
  }
  await runAction(s, order, "register", enc.register(t), waitMs);
}

/**
 * Release calldata carries K_chain, and the relayer's simulation already shows it to the RPC. So the order is read
 * first and the call is built only if it can succeed now (the buyer may have rejected or refunded on-chain).
 */
async function releasable(s: Services, order: OrderRow, check: (v: OrderView) => boolean): Promise<boolean> {
  if (!s.chain) return false;
  let v: OrderView;
  try {
    v = await s.chain.orderOf(s.cfg.factory, order.terms_hash as Hex);
  } catch (e) {
    s.log.warn("chain_read_failed", { order_id: order.id, error: errorText(e, 120) });
    return false;
  }
  if (check(v)) return true;
  const patch = await chainPatch(s, order, v);
  if (Object.keys(patch).length > 0) await s.repo.updateOrder(order.id, patch, nowS(s));
  s.log.info("release_skipped", { order_id: order.id, chain_status: v.status });
  return false;
}

async function releaseInstant(s: Services, order: OrderRow, quote: QuoteRow, t: Terms, now: number, waitMs: number) {
  const { kmaster } = s.cfg.secrets;
  if (!kmaster || !quote.manifest_hash) return;
  if (now > t.deadline - RELEASE_SAFETY_S) return; // too close to the deadline: the keeper refunds after it
  if (!(await releasable(s, order, (v) => v.status === Status.Open))) return;
  const key = await deriveKChain(kmaster, quote.id);
  const charge = payoutAt(t, now + PAYOUT_MARGIN_S);
  await runAction(s, order, "release", enc.release(t, key, charge, quote.manifest_hash as Hex), waitMs);
}

async function releaseStudio(
  s: Services,
  order: OrderRow,
  quote: QuoteRow,
  t: Terms,
  deliveredAt: number,
  waitMs: number,
) {
  const { kmaster } = s.cfg.secrets;
  if (!kmaster || !order.manifest_hash) return;
  const now = nowS(s);
  const ok = await releasable(
    s,
    order,
    (v) => v.status === Status.Delivered && (v.accepted || BigInt(now) >= v.deliveredAt + BigInt(t.reviewWindow)),
  );
  if (!ok) return;
  const key = await deriveKChain(kmaster, quote.id);
  const charge = payoutAt(t, deliveredAt);
  await runAction(s, order, "release", enc.release(t, key, charge, order.manifest_hash as Hex), waitMs);
}

/** A failed funding can still leave USDC at E if the authorization was executed elsewhere: return it. */
async function refundStranded(s: Services, order: OrderRow, t: Terms, now: number, waitMs: number) {
  if (now <= order.deadline || now > order.deadline + 7 * 86_400 || !s.chain) return;
  const bal = await s.chain.balanceOf(t.token, order.escrow as Hex).catch(() => 0n);
  if (bal > 0n) await runAction(s, order, "refund", enc.refund(t), waitMs);
}
