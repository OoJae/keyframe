import { newOrderId, Status } from "@keyframe/protocol";
import type { Address, Hex } from "viem";
import type { OrderRow, QuoteRow } from "../db/rows.js";
import { termsOf } from "../quotes/view.js";
import { nowS, type Services } from "../services.js";
import { advanceOrder, encodeFactoryCall } from "./lifecycle.js";

// Direct rail (architecture.md §c.5; plugin keyframe_commission_direct): the buyer sends USDC.transfer(E, amount)
// itself, so no x402 request ever reaches us. The keeper (and POST /v1/quotes/{id}/rail) looks for funds at E:
// for a live final quote it registers T and opens the order; funds at E of a quote that can no longer be paid are
// returned to T.buyer (cancel before the deadline, refund after it).

export type DirectOutcome = "none" | "underfunded" | "opened" | "busy" | "returned" | "skipped";

const ZERO_TX = `0x${"0".repeat(64)}` as Hex;
const DIRECT = "direct";

function orderRow(q: QuoteRow, fundingTx: Hex, confirmed: boolean, now: number): OrderRow {
  return {
    id: newOrderId(),
    quote_id: q.id,
    tier: q.tier,
    buyer_lc: q.buyer_lc,
    terms_hash: q.terms_hash,
    escrow: q.escrow,
    amount: q.amount,
    deadline: q.deadline,
    status: confirmed ? "sealed" : "funding",
    funding: confirmed ? "confirmed" : "pending",
    funding_tx: fundingTx,
    funding_rail: "direct",
    registered: confirmed ? 1 : 0,
    manifest_hash: q.tier === "instant" ? q.manifest_hash : null,
    delivered_at: null,
    deliver_tx: null,
    accepted: 0,
    decision_tx: null,
    change_requested_at: null,
    release_tx: null,
    refund_tx: null,
    cancel_tx: null,
    to_seller: null,
    to_buyer: null,
    pending_kind: null,
    pending_tx: null,
    pending_since: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

async function openDirect(s: Services, q: QuoteRow, waitMs: number): Promise<DirectOutcome> {
  const now = nowS(s);
  const t = termsOf(q);
  const screen = await s.sanctions.screen(t.buyer);
  if (screen === "unavailable") return "skipped";
  if (screen === "sanctioned") {
    await s.relayer.send({ kind: "cancel", ref: q.id, data: encodeFactoryCall.cancel(t), waitMs });
    await s.repo.cancelQuote(q.id, "sanctioned_direct_payment_returned", now);
    s.log.warn("direct_payment_sanctioned", { quote_id: q.id });
    return "returned";
  }
  if (!(await s.repo.claimQuoteForSettlement(q.id, DIRECT, q.escrow.toLowerCase(), now))) return "busy";

  const r = await s.relayer.send({ kind: "register", ref: q.id, data: encodeFactoryCall.register(t), waitMs });
  let tx: Hex | null = null;
  let confirmed = false;
  if (r.state === "confirmed" || r.state === "pending") {
    tx = r.hash;
    confirmed = r.state === "confirmed";
  } else if (r.state === "rejected" && r.reason.startsWith("AlreadyRegistered") && s.chain) {
    // someone (anyone may call register) opened T already
    const v = await s.chain.orderOf(s.cfg.factory, q.terms_hash as Hex);
    if (v.status === Status.Open) {
      tx = (await s.chain.openedTx(s.cfg.factory, q.terms_hash as Hex).catch(() => null)) ?? ZERO_TX;
      confirmed = true;
    }
  }
  if (!tx) {
    await s.repo.releaseQuoteClaim(q.id, DIRECT, q.escrow.toLowerCase(), nowS(s));
    s.log.warn("direct_register_failed", {
      quote_id: q.id,
      state: r.state,
      ...("reason" in r ? { reason: r.reason } : {}),
    });
    return "skipped";
  }
  const order = orderRow(q, tx, confirmed, nowS(s));
  await s.repo.recordDirectOrder(order, nowS(s));
  s.log.info("order_paid", { order_id: order.id, quote_id: q.id, rail: DIRECT, tx });
  await advanceOrder(s, order, waitMs);
  return "opened";
}

async function returnLateFunds(s: Services, q: QuoteRow, waitMs: number): Promise<DirectOutcome> {
  const t = termsOf(q);
  const now = nowS(s);
  const data = now <= q.deadline ? encodeFactoryCall.cancel(t) : encodeFactoryCall.refund(t);
  const r = await s.relayer.send({ kind: now <= q.deadline ? "cancel" : "refund", ref: q.id, data, waitMs });
  s.log.info("late_funds_returned", { quote_id: q.id, state: r.state });
  return r.state === "confirmed" || r.state === "pending" ? "returned" : "skipped";
}

/** Check one quote's escrow for direct deposits and act on them. */
export async function checkDirect(s: Services, q: QuoteRow, waitMs: number): Promise<DirectOutcome> {
  if (!s.chain) return "skipped";
  const bal = await s.chain.balanceOf(s.cfg.usdc, q.escrow as Address);
  if (bal === 0n) return "none";
  const now = nowS(s);
  const live = q.status === "final" && now < q.quote_expires_at && q.deadline - now >= s.cfg.minReleaseMarginS;
  if (live) return bal >= BigInt(q.amount) ? openDirect(s, q, waitMs) : "underfunded";
  if (q.status === "final" || q.status === "expired" || q.status === "cancelled") return returnLateFunds(s, q, waitMs);
  return "skipped";
}

export async function scanDirectDeposits(s: Services, waitMs: number, limit = 20) {
  const out: Record<DirectOutcome, number> = { none: 0, underfunded: 0, opened: 0, busy: 0, returned: 0, skipped: 0 };
  if (!s.chain) return out;
  for (const q of await s.repo.directCandidates(nowS(s), limit)) {
    try {
      out[await checkDirect(s, q, waitMs)]++;
    } catch (e) {
      out.skipped++;
      s.log.warn("direct_scan_failed", { quote_id: q.id, error: e instanceof Error ? e.name : "error" });
    }
  }
  return out;
}
