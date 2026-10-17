import { newOrderId, sha256Hex, type Terms } from "@keyframe/protocol";
import type { Hex } from "viem";
import type { PaymentRow, QuoteRow } from "../db/rows.js";
import { chargeUnknown, error, notCharged } from "../http.js";
import { chargeable, DRAFT_RETRY_MS, publicStatus, termsOf } from "../quotes/view.js";
import { errorText } from "../redact.js";
import { nowS, type Services } from "../services.js";
import { settleKey } from "../x402/facilitator.js";
import { type DecodedPayment, readPaymentHeader } from "../x402/payment.js";
import type { VerifyOutcome, WireResponse } from "../x402/server.js";
import { advanceOrder } from "./lifecycle.js";
import {
  type Funding,
  orderRowFor,
  PAID_CACHE,
  paidBody,
  reconcileSettlement,
  recordingDelayed,
  recordPaid,
  servePaid,
  settlementHeaders,
} from "./settle.js";

// ALL /v1/orders/{quote_id}: the x402 resource (architecture.md §c.2–§c.4, frozen §7).
//   unpaid  → 402 (byte-identical per quote) | 425 draft | 409 paid | 410 expired/cancelled
//   paid    → replay (bound to the exact header) → x402 verify → business checks → claim → settle → record → 200
// Every refusal before settlement says "charged": false. Once a settlement may have started, the answer is either
// the paid body or "charged": "unknown" (retry the same request / poll) — never "not charged".
// claim → settle → record runs inside a promise registered with waitUntil, so a client disconnect cannot cancel
// the bookkeeping after money moved; anything that still falls through is adopted by the keeper (settle.ts).

const REPLAY_WAIT_MS = 4_000;
const REPLAY_POLL_MS = 100;
/** A retry may reconcile a still-`settling` authorization from the chain after this long. */
const RECONCILE_AFTER_S = 60;

export type Background = (p: Promise<unknown>) => void;

const wire = (r: WireResponse): Response => new Response(r.body, { status: r.status, headers: r.headers });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sigHash = (p: DecodedPayment) => sha256Hex(p.raw);

/** Another request holds this authorization: wait for its stored response or give up. */
async function awaitSettled(s: Services, p: DecodedPayment, sig: string): Promise<Response | "failed" | "timeout"> {
  const until = Date.now() + REPLAY_WAIT_MS;
  for (;;) {
    const row = await s.repo.getPayment(p.fromLc, p.nonceLc);
    if (row?.status === "settled") return servePaid(s.cfg, row, sig, nowS(s));
    if (!row || row.status === "failed") return "failed";
    if (Date.now() >= until) return "timeout";
    await sleep(REPLAY_POLL_MS);
  }
}

const inProgress = (quoteId: string) =>
  chargeUnknown(
    409,
    {
      error: "settlement_in_progress",
      detail: `this authorization is being settled and the outcome is not known yet; retry this exact request (same payment header) or poll GET /v1/quotes/${quoteId} until it is "paid". Do not sign a new payment.`,
      poll: `/v1/quotes/${quoteId}`,
      retry_after_s: 5,
    },
    { "Retry-After": "5" },
  );

/** Responses for a quote that cannot take this payment, in either the unpaid or the paid path. */
function gate(s: Services, q: QuoteRow, now: number): Response | null {
  switch (publicStatus(q, now)) {
    case "draft":
      return notCharged(
        425,
        {
          error: "quote_not_ready",
          status: "draft",
          detail: "the preview and encrypted file are still rendering; poll GET /v1/quotes/{id}",
          retry_after_ms: DRAFT_RETRY_MS,
        },
        { "Retry-After": String(Math.ceil(DRAFT_RETRY_MS / 1000)) },
      );
    case "cancelled":
      return notCharged(410, { error: "quote_cancelled", detail: q.cancel_reason ?? "cancelled" });
    case "expired":
      return notCharged(410, { error: "quote_expired", detail: "request a new quote" });
    case "paid":
      return notCharged(409, { error: "already_paid", order_id: q.order_id });
    default:
      if (s.cfg.maintenance) return notCharged(503, { error: "maintenance" });
      if (s.cfg.problems.length > 0) return notCharged(503, { error: "server_misconfigured" });
      return null;
  }
}

async function businessCheck(s: Services, q: QuoteRow, t: Terms, p: DecodedPayment, now: number) {
  if (p.fromLc !== t.buyer.toLowerCase()) {
    return notCharged(409, {
      error: "payer_mismatch",
      detail: "the paying wallet must be the quoted buyer",
      buyer: t.buyer,
    });
  }
  const screen = await s.sanctions.screen(p.authorization.from);
  if (screen === "sanctioned") return notCharged(451, { error: "sanctioned" });
  if (screen === "unavailable") return notCharged(503, { error: "screening_unavailable" }, { "Retry-After": "60" });
  const c = await s.repo.capacityCounts();
  const full = q.tier === "studio" ? c.studioOpen >= s.cfg.studioMaxOpen : c.instantInflight >= s.cfg.maxInflightOrders;
  if (full)
    return notCharged(503, { error: "at_capacity", detail: "the studio is at capacity" }, { "Retry-After": "120" });
  if (!(now < q.quote_expires_at && q.deadline - now >= s.cfg.minReleaseMarginS)) {
    return notCharged(410, { error: "quote_expired", detail: "request a new quote" });
  }
  return null;
}

/** A still-`settling` authorization presented again: wait, then (after a while) reconcile from the chain. */
async function settlingAgain(s: Services, q: QuoteRow, prior: PaymentRow, p: DecodedPayment, sig: string) {
  if (prior.sig_sha256 && prior.sig_sha256 !== sig) {
    return notCharged(409, { error: "authorization_reused", detail: "this authorization is held by another request" });
  }
  const r = await awaitSettled(s, p, sig);
  if (r instanceof Response) return r;
  if (r === "failed") return null; // the holder failed definitively: this request may try again
  if (nowS(s) - prior.created_at >= RECONCILE_AFTER_S && s.chain) {
    const fresh = await s.repo.getQuote(q.id);
    if (fresh?.status === "settling" && fresh.pay_from === p.fromLc && fresh.pay_nonce === p.nonceLc) {
      const out = await reconcileSettlement(s, fresh, { reopen: false }).catch((e) => {
        s.log.warn("reconcile_failed", { quote_id: q.id, error: errorText(e, 120) });
        return "waiting" as const;
      });
      if (out === "adopted") {
        const row = await s.repo.getPayment(p.fromLc, p.nonceLc);
        if (row?.status === "settled") return servePaid(s.cfg, row, sig, nowS(s));
      }
    }
  }
  return inProgress(q.id);
}

export async function orderResource(s: Services, req: Request, quoteId: string, background: Background) {
  const q = await s.repo.getQuote(quoteId);
  if (!q) return error(404, { error: "unknown_quote" });
  const now = nowS(s);
  const header = readPaymentHeader(req.headers);

  // A malformed payment header is treated like no payment: the client gets the same 402 to retry against.
  if (header.kind !== "ok") {
    const blocked = gate(s, q, now);
    if (blocked) return blocked;
    return wire(await s.x402.challenge(chargeable(q, s.cfg), s.cfg.wire));
  }
  const p = header.payment;
  const sig = await sigHash(p);

  const prior = await s.repo.getPayment(p.fromLc, p.nonceLc);
  if (prior && prior.quote_id !== q.id) return notCharged(409, { error: "authorization_reused" });
  if (prior?.status === "settled") return servePaid(s.cfg, prior, sig, now);
  if (prior?.status === "settling") {
    const r = await settlingAgain(s, q, prior, p, sig);
    if (r) return r;
  }

  const blocked = gate(s, q, now);
  if (blocked) return blocked;
  if (q.status === "settling") return notCharged(409, { error: "already_paid", detail: "another payment is settling" });
  if (!s.chain) return notCharged(503, { error: "chain_unavailable" });

  const target = chargeable(q, s.cfg);
  const verified = p.version === 2 ? await s.x402.verifyV2(target, p, req.method) : await s.x402.verifyV1(target, p);
  if (!verified.ok) return wire(verified.response);

  const t = termsOf(q);
  const refused = await businessCheck(s, q, t, p, now);
  if (refused) return refused;

  // From the claim on, money may move: the whole sequence is owned by waitUntil, and the response awaits it.
  const work = settleAndRecord(s, q, p, sig, verified, background);
  background(work.catch((e) => s.log.error("settle_failed", { quote_id: q.id, error: errorText(e, 160) })));
  return work;
}

async function settleAndRecord(
  s: Services,
  q: QuoteRow,
  p: DecodedPayment,
  sig: string,
  verified: Extract<VerifyOutcome, { ok: true }>,
  background: Background,
): Promise<Response> {
  const now = nowS(s);
  const orderId = newOrderId();
  // Exactly-once: first the authorization, then the quote.
  const wireVersion = p.version === 2 ? "v2" : "v1";
  const bind = { sigSha256: sig, validBefore: p.validBefore, orderId };
  if (!(await s.repo.claimPayment(p.fromLc, p.nonceLc, q.id, wireVersion, now, bind))) {
    const r = await awaitSettled(s, p, sig);
    return r instanceof Response ? r : inProgress(q.id);
  }
  if (!(await s.repo.claimQuoteForSettlement(q.id, p.fromLc, p.nonceLc, now))) {
    await s.repo.failPayment(p.fromLc, p.nonceLc, "quote_unavailable", nowS(s));
    const fresh = await s.repo.getQuote(q.id);
    return (fresh && gate(s, fresh, nowS(s))) ?? notCharged(409, { error: "already_paid" });
  }

  const key = settleKey(p.fromLc, p.nonceLc);
  s.facilitator.expect(key, { terms: termsOf(q), termsHash: q.terms_hash as Hex });
  let settled: Awaited<ReturnType<typeof verified.settle>> | null = null;
  let threw: string | null = null;
  try {
    settled = await verified.settle();
  } catch (e) {
    threw = errorText(e, 120);
  }
  const outcome = s.facilitator.take(key);

  if (outcome?.kind === "settled") {
    // Money moved (even if x402 core reported a failure after our facilitator succeeded).
    const d = outcome.detail;
    const f: Funding = {
      rail: d.rail,
      funding: d.funding,
      tx: d.tx,
      registered: d.rail === "relayer" && d.funding === "confirmed",
    };
    const order = orderRowFor(q, orderId, f, nowS(s));
    const body = await paidBody(s, q, orderId, f);
    const settleHeaders = settled?.ok ? settled.headers : settlementHeaders(wireVersion, d.tx, p.authorization.from);
    const headers = { "Content-Type": "application/json", "Cache-Control": PAID_CACHE, ...settleHeaders };
    const rec = await recordPaid(s, order, {
      fromLc: p.fromLc,
      nonce: p.nonceLc,
      rail: d.rail,
      txHash: d.tx,
      headers,
      body,
    });
    if (rec === "failed") {
      s.log.error("settlement_unrecorded", { quote_id: q.id, order_id: orderId, tx: d.tx });
      return recordingDelayed(q, orderId, d.tx);
    }
    if (rec === "exists") {
      const row = await s.repo.getPayment(p.fromLc, p.nonceLc);
      if (row?.status === "settled") return servePaid(s.cfg, row, sig, nowS(s));
      return inProgress(q.id);
    }
    s.log.info("order_paid", { order_id: orderId, quote_id: q.id, rail: d.rail, funding: d.funding, tx: d.tx });
    background(
      advanceOrder(s, order, 8_000).catch((e) =>
        s.log.error("advance_failed", { order_id: orderId, error: errorText(e, 160) }),
      ),
    );
    return new Response(body, { status: 200, headers });
  }

  const unclear = outcome?.kind === "ambiguous" || threw !== null || settled?.ok === true;
  if (!unclear && settled && !settled.ok) {
    // Definitely nothing moved (simulation revert, no broadcast, on-chain revert): reopen and answer 402.
    await s.repo.failPayment(p.fromLc, p.nonceLc, errorText(settled.reason, 300), nowS(s));
    await s.repo.releaseQuoteClaim(q.id, p.fromLc, p.nonceLc, nowS(s));
    s.log.warn("settlement_failed", { quote_id: q.id, reason: errorText(settled.reason, 160) });
    return wire(settled.response);
  }

  // Unknown outcome (relayer call threw after a possible broadcast, unclear fallback, success without detail):
  // keep the claim, look at the chain now, and adopt if the money is at E. Otherwise the keeper keeps watching.
  const reason = outcome?.kind === "ambiguous" ? outcome.reason : (threw ?? "settlement_detail_missing");
  s.log.warn("settlement_unclear", { quote_id: q.id, reason: errorText(reason, 160) });
  const fresh = await s.repo.getQuote(q.id);
  if (fresh) {
    const out = await reconcileSettlement(s, fresh, { reopen: false }).catch(() => "waiting" as const);
    if (out === "adopted") {
      const row = await s.repo.getPayment(p.fromLc, p.nonceLc);
      if (row?.status === "settled") {
        const order = await s.repo.getOrderByQuote(q.id);
        if (order) background(advanceOrder(s, order, 8_000).catch(() => undefined));
        return servePaid(s.cfg, row, sig, nowS(s));
      }
    }
  }
  return inProgress(q.id);
}
