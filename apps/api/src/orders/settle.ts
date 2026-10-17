import { CAIP2, deriveKBuyer, newOrderId, Status } from "@keyframe/protocol";
import { type Address, type Hex, isAddressEqual } from "viem";
import type { Config } from "../config.js";
import type { OrderRow, PaymentRow, QuoteRow } from "../db/rows.js";
import { error, json } from "../http.js";
import { termsOf } from "../quotes/view.js";
import { errorText } from "../redact.js";
import { nowS, type Services } from "../services.js";
import { V1_NETWORK } from "../x402/facilitator.js";
import { utf8ToBase64 } from "../x402/payment.js";
import { accessToken } from "./access.js";
import { patchFromChain } from "./lifecycle.js";

// Settlement bookkeeping shared by the paid request path and the keeper: the §7 paid body, the replay store
// (bound to the exact payment header, full body only briefly), and adoption of orphaned settlements (money at E,
// no order row because the isolate died, D1 failed or the relayer call threw after broadcasting).

export const PAID_CACHE = "no-store, private";
/** The stored paid body (access_token, k_buyer) is replayed in full for at most this long after settlement. */
export const REPLAY_FULL_S = 120;
export const ZERO_TX = `0x${"0".repeat(64)}` as Hex;

export interface Funding {
  rail: OrderRow["funding_rail"];
  funding: "confirmed" | "pending";
  tx: Hex;
  /** T is registered on-chain (fundWithAuthorization) — false for funds at E awaiting register(T). */
  registered: boolean;
}

export function orderRowFor(q: QuoteRow, id: string, f: Funding, now: number, patch: Partial<OrderRow> = {}): OrderRow {
  return {
    id,
    quote_id: q.id,
    tier: q.tier,
    buyer_lc: q.buyer_lc,
    terms_hash: q.terms_hash,
    escrow: q.escrow,
    amount: q.amount,
    deadline: q.deadline,
    status: f.funding === "confirmed" ? "sealed" : "funding",
    funding: f.funding,
    funding_tx: f.tx,
    funding_rail: f.rail,
    registered: f.registered ? 1 : 0,
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
    ...patch,
  };
}

/** The §7 paid 200 body (byte-stable: field order is fixed). */
export async function paidBody(s: Services, q: QuoteRow, orderId: string, f: Funding): Promise<string> {
  const { accessSecret, kmaster } = s.cfg.secrets;
  if (!accessSecret || !kmaster) throw new Error("secrets vanished after the configuration gate");
  const kBuyer = q.delivery === "private" ? await deriveKBuyer(kmaster, q.id) : null;
  return JSON.stringify({
    v: 1,
    order_id: orderId,
    access_token: await accessToken(accessSecret, orderId),
    quote_id: q.id,
    terms_hash: q.terms_hash,
    escrow: q.escrow,
    amount: q.amount,
    deadline: q.deadline,
    funding_tx: f.tx,
    funding: f.funding,
    k_buyer: kBuyer,
    status_url: `${s.cfg.publicBaseUrl}/v1/orders/${orderId}`,
    next: "keyframe_verify",
  });
}

/** x402 settlement header for a paid response we assemble ourselves (adoption: no live settle result). */
export function settlementHeaders(wire: "v1" | "v2", tx: Hex, payer: string): Record<string, string> {
  const network = wire === "v2" ? CAIP2 : V1_NETWORK;
  const value = utf8ToBase64(JSON.stringify({ success: true, transaction: tx, network, payer }));
  return wire === "v2" ? { "PAYMENT-RESPONSE": value } : { "X-PAYMENT-RESPONSE": value };
}

const fullUntil = (p: PaymentRow): number => {
  const settled = p.settled_at ?? p.updated_at;
  return Math.min(settled + REPLAY_FULL_S, p.valid_before ?? Number.MAX_SAFE_INTEGER);
};

/**
 * Replay of a settled payment. (from, nonce) and even the signature are public once fundWithAuthorization is on
 * chain, so the stored body is served only to the exact payment header that settled it, and in full only within
 * REPLAY_FULL_S of settlement (and before validBefore). Afterwards access_token and k_buyer are null and the
 * client is pointed at SIWE recovery (keyframe_orders).
 */
export function servePaid(cfg: Config, p: PaymentRow, sigSha256: string, now: number): Response {
  if (p.sig_sha256 && p.sig_sha256 !== sigSha256) {
    return error(409, {
      error: "authorization_reused",
      detail:
        "this authorization was already settled with a different payment header; recover the order with keyframe_orders (SIWE)",
      charged: false,
    });
  }
  const headers = JSON.parse(p.response_headers ?? "{}") as Record<string, string>;
  if (p.sig_sha256 === sigSha256 && now <= fullUntil(p)) {
    return new Response(p.response_body, { status: p.response_status ?? 200, headers });
  }
  const body = JSON.parse(p.response_body ?? "{}") as Record<string, unknown>;
  body.access_token = null;
  body.k_buyer = null;
  body.secrets_withheld = true;
  body.recover = {
    tool: "keyframe_orders",
    challenge: `${cfg.publicBaseUrl}/v1/auth/siwe/challenge`,
    verify: `${cfg.publicBaseUrl}/v1/auth/siwe/verify`,
  };
  body.note =
    "This payment was settled earlier. For safety the access_token and k_buyer are only returned right after settlement; sign in with the buyer wallet (keyframe_orders, SIWE) to recover them.";
  return new Response(JSON.stringify(body), { status: p.response_status ?? 200, headers });
}

/** Record (or confirm someone else recorded) a settlement; retries transient D1 errors. */
export async function recordPaid(
  s: Services,
  order: OrderRow,
  payment: {
    fromLc: string;
    nonce: string;
    rail: string;
    txHash: string;
    headers: Record<string, string>;
    body: string;
  },
): Promise<"recorded" | "exists" | "failed"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const mine = await s.repo.recordSettlement(
        order,
        { ...payment, status: 200, headers: JSON.stringify(payment.headers) },
        nowS(s),
      );
      return mine ? "recorded" : "exists";
    } catch (e) {
      s.log.warn("record_settlement_retry", { quote_id: order.quote_id, attempt, error: errorText(e, 120) });
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  return "failed";
}

export type ReconcileOutcome = "adopted" | "reopened" | "waiting";

/**
 * A quote stuck in `settling` for an authorization: decide from the chain. T registered (any status) or E holding
 * the amount ⇒ adopt (order row + paid body, payment settled; an unregistered E is registered by the lifecycle).
 * Nothing at E and the authorization unused ⇒ (only with `reopen`) fail the payment and reopen the quote. Never
 * reopen a quote whose escrow is funded or whose authorization was used.
 */
export async function reconcileSettlement(
  s: Services,
  q: QuoteRow,
  opts: { reopen: boolean },
): Promise<ReconcileOutcome> {
  const chain = s.chain;
  if (!chain || q.status !== "settling" || !q.pay_from || !q.pay_nonce || q.pay_from === "direct") return "waiting";
  const t = termsOf(q);
  const pay = await s.repo.getPayment(q.pay_from, q.pay_nonce);
  const view = await chain.orderOf(s.cfg.factory, q.terms_hash as Hex);
  let funding: Funding | null = null;
  let patch: Partial<OrderRow> = {};
  if (view.status !== Status.None) {
    if (!isAddressEqual(view.buyer, t.buyer)) {
      s.log.error("orphan_settlement_buyer_mismatch", { quote_id: q.id, chain_status: view.status });
      return "waiting";
    }
    const tx = (await chain.eventTx(s.cfg.factory, "Opened", q.terms_hash as Hex).catch(() => null)) ?? ZERO_TX;
    funding = { rail: pay?.rail === "payai" ? "payai" : "relayer", funding: "confirmed", tx, registered: true };
    patch = patchFromChain(view);
  } else {
    const bal = await chain.balanceOf(s.cfg.usdc, q.escrow as Address);
    if (bal >= BigInt(q.amount)) {
      const transfers = await chain.transfersTo(s.cfg.usdc, q.escrow as Address).catch(() => []);
      funding = { rail: "payai", funding: "confirmed", tx: transfers[0]?.tx ?? ZERO_TX, registered: false };
    } else if (bal > 0n) {
      // Less than the amount (someone else's partial transfer): not this authorization's money. It stays
      // refundable to T.buyer; the quote may be reopened below if the authorization is unused.
      s.log.warn("orphan_settlement_partial_funds", { quote_id: q.id, escrow: q.escrow });
    }
  }
  if (!funding) {
    if (!opts.reopen) return "waiting";
    const used = await chain.authorizationState(s.cfg.usdc, q.pay_from as Address, q.pay_nonce as Hex);
    if (used) {
      s.log.error("orphan_settlement_authorization_used", { quote_id: q.id, escrow: q.escrow });
      return "waiting";
    }
    const now = nowS(s);
    await s.repo.failPayment(q.pay_from, q.pay_nonce, "settlement_abandoned", now);
    await s.repo.releaseQuoteClaim(q.id, q.pay_from, q.pay_nonce, now);
    s.log.warn("settlement_reopened", { quote_id: q.id });
    return "reopened";
  }
  const now = nowS(s);
  const orderId = pay?.order_id ?? newOrderId();
  const order = orderRowFor(q, orderId, funding, now, patch);
  const body = await paidBody(s, q, orderId, funding);
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": PAID_CACHE,
    ...settlementHeaders(pay?.wire ?? "v2", funding.tx, q.pay_from),
  };
  const r = await recordPaid(s, order, {
    fromLc: q.pay_from,
    nonce: q.pay_nonce,
    rail: funding.rail,
    txHash: funding.tx,
    headers,
    body,
  });
  if (r === "failed") return "waiting";
  s.log.warn("orphan_settlement_adopted", { quote_id: q.id, order_id: orderId, registered: funding.registered });
  return "adopted";
}

/** JSON for a settled authorization whose bookkeeping could not be written yet (money moved). */
export const recordingDelayed = (q: QuoteRow, orderId: string, tx: Hex) =>
  json(
    503,
    {
      error: "settlement_recording_delayed",
      detail:
        "Your payment was settled on-chain; the order is still being recorded. Retry this exact request (same payment header) shortly, or recover the order with keyframe_orders. Do not pay again.",
      message: "Payment settled; order recording delayed. Retry the same request shortly; do not pay again.",
      charged: true,
      quote_id: q.id,
      order_id: orderId,
      funding_tx: tx,
    },
    { "Retry-After": "30" },
  );
