import { MIN_AMOUNT, newOrderId, Status } from "@keyframe/protocol";
import type { Address, Hex } from "viem";
import type { QuoteRow } from "../db/rows.js";
import { DEFAULT_LOGS_BUDGET_MS } from "../logs.js";
import { termsOf } from "../quotes/view.js";
import { errorText } from "../redact.js";
import { nowS, type Services } from "../services.js";
import { advanceOrder, encodeFactoryCall } from "./lifecycle.js";
import { orderRowFor, ZERO_TX } from "./settle.js";

// Direct rail (architecture.md §c.5; plugin keyframe_commission_direct): the buyer sends USDC.transfer(E, amount)
// itself, so no x402 request ever reaches us. The keeper (and POST /v1/quotes/{id}/rail) looks for funds at E:
// for a live final quote it screens every sender, registers T and opens the order; funds at E of a quote that can
// no longer be paid are returned to T.buyer (cancel before the deadline, refund after it), one action per quote
// at a time and never for dust.

export type DirectOutcome = "none" | "underfunded" | "opened" | "busy" | "returned" | "skipped" | "refused" | "dust";

const DIRECT = "direct";
/** One late-fund action per quote per this many seconds (cancel/refund in flight). */
const LATE_SLOT_S = 300;
/** Late funds below this are left for the buyer to refund themselves (refund/sweep are permissionless). */
const LATE_FUNDS_MIN = MIN_AMOUNT;
/** Quotes cancelled because funds came from a sanctioned party: the relayer never moves those funds. */
export const SANCTIONED_SENDER = "sanctioned_sender";

/**
 * OFAC screening of every address that sent USDC to E (not just T.buyer: anyone can transfer to E). Clear only if
 * all senders are clear and the logs account for the balance. E is derived from T, which the API first publishes
 * when it creates the quote, so the Transfer logs are read from the block estimated for created_at (plus margin) to
 * the head; a transfer the scan misses shows up as an unattributed balance (fail closed).
 */
async function screenSenders(
  s: Services,
  q: QuoteRow,
  bal: bigint,
  deadlineMs: number,
): Promise<"clear" | "sanctioned" | "unavailable"> {
  if (!s.chain) return "unavailable";
  let transfers: Awaited<ReturnType<NonNullable<Services["chain"]>["transfersTo"]>>;
  try {
    transfers = await s.chain.transfersTo(s.cfg.usdc, q.escrow as Address, {
      sinceS: q.created_at,
      nowS: nowS(s),
      deadlineMs,
    });
  } catch (e) {
    s.log.warn("direct_transfer_logs_failed", { quote_id: q.id, error: errorText(e, 120) });
    return "unavailable";
  }
  const total = transfers.reduce((a, t) => a + t.value, 0n);
  if (total < bal) {
    s.log.warn("direct_funds_unattributed", { quote_id: q.id, escrow: q.escrow });
    return "unavailable";
  }
  const senders = [...new Set([termsOf(q).buyer, ...transfers.map((t) => t.from)].map((a) => a.toLowerCase()))];
  for (const a of senders) {
    const r = await s.sanctions.screen(a);
    if (r !== "clear") return r;
  }
  return "clear";
}

async function openDirect(
  s: Services,
  q: QuoteRow,
  bal: bigint,
  waitMs: number,
  deadlineMs: number,
): Promise<DirectOutcome> {
  const now = nowS(s);
  const t = termsOf(q);
  const buyerScreen = await s.sanctions.screen(t.buyer);
  if (buyerScreen === "unavailable") return "skipped";
  if (buyerScreen === "sanctioned") {
    // ADR-007: never serve; return the payment to the payer (cancel), one attempt per slot.
    if (!(await s.repo.claimLateAction(q.id, now, now - LATE_SLOT_S))) return "busy";
    await s.relayer.send({ kind: "cancel", ref: q.id, data: encodeFactoryCall.cancel(t), waitMs });
    await s.repo.cancelQuote(q.id, "sanctioned_direct_payment_returned", now);
    s.log.warn("direct_payment_sanctioned", { quote_id: q.id });
    return "returned";
  }
  const senders = await screenSenders(s, q, bal, deadlineMs);
  if (senders === "unavailable") return "skipped";
  if (senders === "sanctioned") {
    // Do not register or serve, and do not touch the funds: they stay refundable to T.buyer (refund after deadline).
    await s.repo.cancelQuote(q.id, SANCTIONED_SENDER, now);
    s.log.error("direct_sender_sanctioned", { quote_id: q.id, escrow: q.escrow });
    return "refused";
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
      tx =
        (await s.chain
          .openedTx(s.cfg.factory, q.terms_hash as Hex, { sinceS: Number(v.openedAt) })
          .catch(() => null)) ?? ZERO_TX;
      confirmed = true;
    }
  }
  if (!tx) {
    await s.repo.releaseQuoteClaim(q.id, DIRECT, q.escrow.toLowerCase(), nowS(s));
    s.log.warn("direct_register_failed", {
      quote_id: q.id,
      state: r.state,
      ...("reason" in r ? { reason: errorText(r.reason, 160) } : {}),
    });
    return "skipped";
  }
  const order = orderRowFor(
    q,
    newOrderId(),
    { rail: "direct", funding: confirmed ? "confirmed" : "pending", tx, registered: confirmed },
    nowS(s),
  );
  if (!(await s.repo.recordDirectOrder(order, nowS(s)))) return "busy";
  s.log.info("order_paid", { order_id: order.id, quote_id: q.id, rail: DIRECT, tx });
  await advanceOrder(s, order, waitMs);
  return "opened";
}

async function returnLateFunds(s: Services, q: QuoteRow, bal: bigint, waitMs: number): Promise<DirectOutcome> {
  if (q.cancel_reason === SANCTIONED_SENDER || q.cancel_reason === "sanctioned_direct_payment_returned") {
    return "skipped";
  }
  if (bal < LATE_FUNDS_MIN) {
    s.log.info("late_funds_dust", { quote_id: q.id, escrow: q.escrow });
    return "dust";
  }
  const now = nowS(s);
  if (!(await s.repo.claimLateAction(q.id, now, now - LATE_SLOT_S))) return "busy";
  const t = termsOf(q);
  // Already terminal on-chain (e.g. cancelled earlier): the residue is the buyer's to sweep; no relayer gas for it.
  if (s.chain) {
    const v = await s.chain.orderOf(s.cfg.factory, q.terms_hash as Hex).catch(() => null);
    if (v && v.status !== Status.None && v.status !== Status.Open) return "skipped";
  }
  const kind = now <= q.deadline ? "cancel" : "refund";
  const data = kind === "cancel" ? encodeFactoryCall.cancel(t) : encodeFactoryCall.refund(t);
  const r = await s.relayer.send({ kind, ref: q.id, data, waitMs });
  s.log.info("late_funds_returned", { quote_id: q.id, state: r.state });
  if (r.state === "rejected" || r.state === "unavailable") await s.repo.releaseLateAction(q.id, now);
  return r.state === "confirmed" || r.state === "pending" ? "returned" : "skipped";
}

/**
 * Check one quote's escrow for direct deposits and act on them. `deadlineMs` bounds the sender-screening log scan
 * (default: 10 s from now); a scan that cannot finish in time screens as unavailable (skipped, retried later).
 */
export async function checkDirect(
  s: Services,
  q: QuoteRow,
  waitMs: number,
  deadlineMs: number = Date.now() + DEFAULT_LOGS_BUDGET_MS,
): Promise<DirectOutcome> {
  if (!s.chain) return "skipped";
  const bal = await s.chain.balanceOf(s.cfg.usdc, q.escrow as Address);
  if (bal === 0n) return "none";
  const now = nowS(s);
  const live = q.status === "final" && now < q.quote_expires_at && q.deadline - now >= s.cfg.minReleaseMarginS;
  if (live) return bal >= BigInt(q.amount) ? openDirect(s, q, bal, waitMs, deadlineMs) : "underfunded";
  if (q.status === "final" || q.status === "expired" || q.status === "cancelled") {
    return returnLateFunds(s, q, bal, waitMs);
  }
  return "skipped";
}

export async function scanDirectDeposits(
  s: Services,
  waitMs: number,
  limit = 20,
  deadlineMs = Number.POSITIVE_INFINITY,
) {
  const out: Record<DirectOutcome, number> = {
    none: 0,
    underfunded: 0,
    opened: 0,
    busy: 0,
    returned: 0,
    skipped: 0,
    refused: 0,
    dust: 0,
  };
  if (!s.chain) return out;
  for (const q of await s.repo.directCandidates(nowS(s), limit)) {
    if (Date.now() > deadlineMs) break;
    try {
      out[await checkDirect(s, q, waitMs, Math.min(deadlineMs, Date.now() + DEFAULT_LOGS_BUDGET_MS))]++;
    } catch (e) {
      out.skipped++;
      s.log.warn("direct_scan_failed", { quote_id: q.id, error: errorText(e, 120) });
    }
  }
  return out;
}
