import { type Spec, type TermsJson, termsFromJson } from "@keyframe/protocol";
import { getAddress } from "viem";
import { catalogItem, formatUsdc } from "../catalog.js";
import type { Config } from "../config.js";
import type { QuoteRow } from "../db/rows.js";
import { keys } from "../storage.js";
import type { ChargeableQuote } from "../x402/server.js";

// The §7 quote object (fields the plugin relies on) plus additive fields. Settling is reported as "final":
// the buyer-visible state only changes to "paid" once settlement succeeded.

export const DISCLOSURES: readonly string[] = [
  "Pay-on-delivery escrow: the USDC waits at the escrow address and can reach the studio only when the key to your file is published on Base before the deadline; otherwise it can only return to the buyer.",
  "We guarantee you get the file you approved, on time, or your money back. We can't guarantee you'll love it; that's why you see the key frame before you pay.",
  "Unaudited contracts; every order is capped at 50 USDC.",
  "Templates are hand-designed by Keyframe's designer; agents only fill typed fields.",
];

export const DRAFT_RETRY_MS = 3000;

/** Shown on drafts: their terms/escrow are provisional (they change when the quote turns final). */
export const DRAFT_NOTICE =
  "Draft: terms, terms_hash and escrow are provisional and change when the quote turns final. Do not pay or send funds to this escrow; wait for status final.";

export type PublicQuoteStatus = "draft" | "final" | "paid" | "expired" | "cancelled";

export function publicStatus(q: QuoteRow, nowS: number): PublicQuoteStatus {
  switch (q.status) {
    case "settling":
      return "final";
    case "final":
      return nowS >= q.quote_expires_at ? "expired" : "final";
    default:
      return q.status;
  }
}

export const orderUrl = (cfg: Config, quoteId: string) => `${cfg.publicBaseUrl}/v1/orders/${quoteId}`;
export const manifestUrl = (cfg: Config, manifestHash: string) => `${cfg.filesBaseUrl}/${keys.manifest(manifestHash)}`;

export function quoteView(q: QuoteRow, cfg: Config, nowS: number) {
  const status = publicStatus(q, nowS);
  const amount = BigInt(q.amount);
  return {
    v: 1,
    quote_id: q.id,
    status,
    tier: q.tier,
    format: q.format,
    buyer: q.buyer,
    price: { atomic: q.amount, usdc: formatUsdc(amount) },
    eta_s: q.eta_s,
    quote_expires_at: q.quote_expires_at,
    deadline: q.deadline,
    factory: cfg.factory,
    vault_impl: cfg.vaultImpl,
    terms: JSON.parse(q.terms_json) as TermsJson,
    terms_hash: q.terms_hash,
    escrow: q.escrow,
    spec: JSON.parse(q.spec_json) as Spec,
    spec_hash: q.spec_hash,
    preview: { still_url: q.still_url, still_sha256: q.still_sha256, video_url: q.preview_url },
    content: {
      manifest_url: q.manifest_hash ? manifestUrl(cfg, q.manifest_hash) : null,
      manifest_hash: q.manifest_hash,
    },
    delivery: q.delivery,
    retry_after_ms: status === "draft" ? DRAFT_RETRY_MS : 0,
    disclosures: DISCLOSURES,
    // additive
    catalog_id: q.catalog_id,
    order_url: orderUrl(cfg, q.id),
    order_id: q.order_id,
    provisional: status === "draft",
    payable: status === "final" && q.status === "final",
    terms_final: status !== "draft",
    ...(status === "draft" ? { escrow_status: "provisional_do_not_pay", notice: DRAFT_NOTICE } : {}),
    ...(q.cancel_reason ? { cancel_reason: q.cancel_reason } : {}),
  };
}

function isoMinute(unix: number): string {
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Immutable per-quote x402 description (no clocks: everything comes from the final quote). */
export function x402Description(q: QuoteRow): string {
  const spec = JSON.parse(q.spec_json) as Spec;
  const title = catalogItem(q.catalog_id)?.title ?? q.catalog_id;
  const e = q.escrow;
  return (
    `Keyframe order ${q.id}: ${title} ${spec.durationS}s ${spec.aspect}. ` +
    `Pay-on-delivery escrow ${e.slice(0, 6)}…${e.slice(-4)}; refundable to the buyer after ${isoMinute(q.deadline)}.`
  );
}

export function chargeable(q: QuoteRow, cfg: Config): ChargeableQuote {
  return {
    quoteId: q.id,
    escrow: getAddress(q.escrow),
    amount: q.amount,
    url: orderUrl(cfg, q.id),
    description: x402Description(q),
  };
}

export const termsOf = (q: QuoteRow) => termsFromJson(JSON.parse(q.terms_json));
