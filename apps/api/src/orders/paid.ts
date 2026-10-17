import { deriveKBuyer, newOrderId, type Terms } from "@keyframe/protocol";
import type { Hex } from "viem";
import type { OrderRow, PaymentRow, QuoteRow } from "../db/rows.js";
import { error, notCharged } from "../http.js";
import { chargeable, DRAFT_RETRY_MS, publicStatus, termsOf } from "../quotes/view.js";
import { nowS, type Services } from "../services.js";
import { settleKey } from "../x402/facilitator.js";
import { type DecodedPayment, readPaymentHeader } from "../x402/payment.js";
import type { WireResponse } from "../x402/server.js";
import { accessToken } from "./access.js";
import { advanceOrder } from "./lifecycle.js";

// ALL /v1/orders/{quote_id}: the x402 resource (architecture.md §c.2–§c.4, frozen §7).
//   unpaid  → 402 (byte-identical per quote) | 425 draft | 409 paid | 410 expired/cancelled
//   paid    → replay by (from, nonce) → x402 verify → business checks → CAS → settle → 200 paid body
// Every refusal before settlement says "charged": false; 409/410/451/503 never reach settlement.

const REPLAY_WAIT_MS = 4_000;
const REPLAY_POLL_MS = 100;
const PAID_CACHE = "no-store, private";

export type Background = (p: Promise<unknown>) => void;

const wire = (r: WireResponse): Response => new Response(r.body, { status: r.status, headers: r.headers });

function replay(p: PaymentRow): Response {
  return new Response(p.response_body, {
    status: p.response_status ?? 200,
    headers: JSON.parse(p.response_headers ?? "{}") as Record<string, string>,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Another request holds this authorization: wait for its stored response (identical bytes) or give up. */
async function awaitSettled(s: Services, fromLc: string, nonce: string): Promise<Response | "failed" | "timeout"> {
  const until = Date.now() + REPLAY_WAIT_MS;
  for (;;) {
    const p = await s.repo.getPayment(fromLc, nonce);
    if (p?.status === "settled") return replay(p);
    if (!p || p.status === "failed") return "failed";
    if (Date.now() >= until) return "timeout";
    await sleep(REPLAY_POLL_MS);
  }
}

const inProgress = () =>
  notCharged(
    409,
    { error: "settlement_in_progress", detail: "this authorization is being settled; retry" },
    { "Retry-After": "2" },
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

  const prior = await s.repo.getPayment(p.fromLc, p.nonceLc);
  if (prior && prior.quote_id !== q.id) return notCharged(409, { error: "authorization_reused" });
  if (prior?.status === "settled") return replay(prior);
  if (prior?.status === "settling") {
    const r = await awaitSettled(s, p.fromLc, p.nonceLc);
    if (r instanceof Response) return r;
    if (r === "timeout") return inProgress();
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

  // Exactly-once: first the authorization, then the quote.
  const wireVersion = p.version === 2 ? "v2" : "v1";
  if (!(await s.repo.claimPayment(p.fromLc, p.nonceLc, q.id, wireVersion, now))) {
    const r = await awaitSettled(s, p.fromLc, p.nonceLc);
    return r instanceof Response ? r : inProgress();
  }
  if (!(await s.repo.claimQuoteForSettlement(q.id, p.fromLc, p.nonceLc, now))) {
    await s.repo.failPayment(p.fromLc, p.nonceLc, "quote_unavailable", nowS(s));
    const fresh = await s.repo.getQuote(q.id);
    return (fresh && gate(s, fresh, nowS(s))) ?? notCharged(409, { error: "already_paid" });
  }

  const key = settleKey(p.fromLc, p.nonceLc);
  s.facilitator.expect(key, { terms: t, termsHash: q.terms_hash as Hex });
  let settled: Awaited<ReturnType<typeof verified.settle>>;
  try {
    settled = await verified.settle();
  } catch (e) {
    settled = {
      ok: false,
      reason: e instanceof Error ? e.message.slice(0, 120) : "settlement_error",
      response: await s.x402.challenge(target, s.cfg.wire),
    };
  }
  const detail = s.facilitator.take(key);
  if (!settled.ok || !detail) {
    const reason = settled.ok ? "settlement_detail_missing" : settled.reason;
    await s.repo.failPayment(p.fromLc, p.nonceLc, reason, nowS(s));
    await s.repo.releaseQuoteClaim(q.id, p.fromLc, p.nonceLc, nowS(s));
    s.log.warn("settlement_failed", { quote_id: q.id, reason });
    if (settled.ok) return notCharged(502, { error: "settlement_failed" });
    return wire(settled.response);
  }

  const orderId = newOrderId();
  const { accessSecret, kmaster } = s.cfg.secrets;
  if (!accessSecret || !kmaster) throw new Error("secrets vanished after the configuration gate");
  const kBuyer = q.delivery === "private" ? await deriveKBuyer(kmaster, q.id) : null;
  const body = JSON.stringify({
    v: 1,
    order_id: orderId,
    access_token: await accessToken(accessSecret, orderId),
    quote_id: q.id,
    terms_hash: q.terms_hash,
    escrow: q.escrow,
    amount: q.amount,
    deadline: q.deadline,
    funding_tx: detail.tx,
    funding: detail.funding,
    k_buyer: kBuyer,
    status_url: `${s.cfg.publicBaseUrl}/v1/orders/${orderId}`,
    next: "keyframe_verify",
  });
  const headers = { "Content-Type": "application/json", "Cache-Control": PAID_CACHE, ...settled.headers };
  const at = nowS(s);
  const order: OrderRow = {
    id: orderId,
    quote_id: q.id,
    tier: q.tier,
    buyer_lc: q.buyer_lc,
    terms_hash: q.terms_hash,
    escrow: q.escrow,
    amount: q.amount,
    deadline: q.deadline,
    status: detail.funding === "confirmed" ? "sealed" : "funding",
    funding: detail.funding,
    funding_tx: detail.tx,
    funding_rail: detail.rail,
    registered: detail.rail === "relayer" && detail.funding === "confirmed" ? 1 : 0,
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
    created_at: at,
    updated_at: at,
  };
  await s.repo.recordSettlement(
    order,
    {
      fromLc: p.fromLc,
      nonce: p.nonceLc,
      rail: detail.rail,
      txHash: detail.tx,
      status: 200,
      headers: JSON.stringify(headers),
      body,
    },
    at,
  );
  s.log.info("order_paid", {
    order_id: orderId,
    quote_id: q.id,
    rail: detail.rail,
    funding: detail.funding,
    tx: detail.tx,
  });
  background(
    advanceOrder(s, order, 8_000).catch((e) => s.log.error("advance_failed", { order_id: orderId, error: String(e) })),
  );
  return new Response(body, { status: 200, headers });
}
