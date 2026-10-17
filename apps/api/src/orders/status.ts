import { deriveKBuyer } from "@keyframe/protocol";
import { getAddress, isAddress } from "viem";
import type { OrderRow, QuoteRow } from "../db/rows.js";
import { error, json } from "../http.js";
import { manifestUrl, termsOf } from "../quotes/view.js";
import { nowS, type Services } from "../services.js";
import { orderLinks } from "../web/links.js";
import { accessToken, checkAccessToken } from "./access.js";
import { CHANGES_POLICY, RELEASE_GRACE_S, studioWindows } from "./lifecycle.js";

// GET /v1/orders/{order_id}?token= and GET /v1/orders?buyer=. Public views carry no secrets; with a valid
// access_token the owner also gets k_buyer (private delivery) and, for private orders, the preview links.

const POLL_S: Record<OrderRow["status"], number> = {
  funding: 3,
  sealed: 5,
  delivered: 60,
  key_published: 0,
  returned: 0,
  void: 0,
  failed: 0,
};

function timeline(o: OrderRow) {
  const t: { at: number | null; event: string; tx?: string | null }[] = [
    { at: o.created_at, event: "paid", tx: o.funding_tx },
  ];
  if (o.funding === "confirmed") t.push({ at: null, event: "sealed", tx: o.funding_tx });
  if (o.delivered_at) t.push({ at: o.delivered_at, event: "delivered", tx: o.deliver_tx });
  if (o.change_requested_at) t.push({ at: o.change_requested_at, event: "changes_requested" });
  if (o.revision_delivered_at) t.push({ at: o.revision_delivered_at, event: "revision_delivered" });
  if (o.buyer_accepted_at) t.push({ at: o.buyer_accepted_at, event: "accepted" });
  if (o.status === "key_published") t.push({ at: null, event: "key_published", tx: o.release_tx });
  if (o.status === "returned") t.push({ at: null, event: "returned", tx: o.refund_tx ?? o.decision_tx });
  if (o.status === "void") t.push({ at: null, event: "void", tx: o.cancel_tx });
  if (o.status === "failed") t.push({ at: null, event: "funding_failed" });
  return t;
}

export async function orderView(s: Services, o: OrderRow, q: QuoteRow, owner: boolean) {
  const t = termsOf(q);
  const showPrivate = owner || q.delivery === "public";
  const reviewEndsAt = o.delivered_at ? o.delivered_at + t.reviewWindow : null;
  const { kmaster } = s.cfg.secrets;
  return {
    v: 1,
    order_id: o.id,
    status: o.status,
    tier: o.tier,
    format: q.format,
    catalog_id: q.catalog_id,
    delivery: q.delivery,
    terms_hash: o.terms_hash,
    escrow: o.escrow,
    amount: o.amount,
    deadline: o.deadline,
    funding: o.funding,
    funding_tx: o.funding_tx,
    release_tx: o.release_tx,
    refund_tx: o.refund_tx,
    cancel_tx: o.cancel_tx,
    deliver_tx: o.deliver_tx,
    decision_tx: o.decision_tx,
    manifest_hash: o.manifest_hash,
    manifest_url: o.manifest_hash ? manifestUrl(s.cfg, o.manifest_hash) : null,
    to_seller: o.to_seller,
    to_buyer: o.to_buyer,
    delivered_at: o.delivered_at,
    review_ends_at: reviewEndsAt,
    release_deadline: reviewEndsAt !== null ? reviewEndsAt + RELEASE_GRACE_S : null,
    accepted: o.accepted === 1 || (o.buyer_accepted_at ?? null) !== null,
    ...(o.change_requested_at
      ? {
          changes: {
            requested_at: o.change_requested_at,
            accept_by: studioWindows(o, t).acceptBy,
            revision: o.revision_delivered_at
              ? {
                  delivered_at: o.revision_delivered_at,
                  manifest_hash: o.revision_manifest_hash ?? null,
                  manifest_url: o.revision_manifest_hash ? manifestUrl(s.cfg, o.revision_manifest_hash) : null,
                  ...(showPrivate ? { preview_url: o.revision_preview_url ?? null } : {}),
                }
              : null,
            policy: CHANGES_POLICY,
          },
        }
      : {}),
    timeline: timeline(o),
    poll_after_s: POLL_S[o.status],
    access: owner ? "owner" : "public",
    factory: s.cfg.factory,
    ...(showPrivate
      ? {
          quote_id: q.id,
          still_url: q.still_url,
          preview_url: q.preview_url,
          terms: JSON.parse(q.terms_json),
          spec: JSON.parse(q.spec_json),
        }
      : {}),
    ...(owner && q.delivery === "private" && kmaster ? { k_buyer: await deriveKBuyer(kmaster, q.id) } : {}),
    ...orderLinks(s.cfg, o),
  };
}

export async function getOrder(s: Services, orderId: string, token: string | undefined): Promise<Response> {
  const o = await s.repo.getOrder(orderId);
  if (!o) return error(404, { error: "unknown_order" });
  const q = await s.repo.getQuote(o.quote_id);
  if (!q) return error(500, { error: "order_without_quote" });
  const secret = s.cfg.secrets.accessSecret;
  const owner = token !== undefined && secret !== null && (await checkAccessToken(secret, o.id, token));
  if (token !== undefined && !owner) return error(401, { error: "invalid_token" });
  return json(200, await orderView(s, o, q, owner));
}

export async function listOrders(s: Services, buyer: string | undefined): Promise<Response> {
  if (!buyer || !isAddress(buyer, { strict: false })) return error(400, { error: "buyer_required" });
  const rows = await s.repo.listOrdersByBuyer(buyer.toLowerCase(), 50);
  return json(200, {
    v: 1,
    buyer: getAddress(buyer),
    orders: rows.map((o) => ({
      order_id: o.id,
      status: o.status,
      tier: o.tier,
      created_at: o.created_at,
      ...orderLinks(s.cfg, o),
    })),
    as_of: nowS(s),
  });
}

/** Owner bundle (SIWE re-delivery): fresh access tokens and k_buyer. */
export async function ownerOrders(s: Services, buyerLc: string) {
  const { accessSecret, kmaster } = s.cfg.secrets;
  if (!accessSecret || !kmaster) return [];
  const rows = await s.repo.listOrdersByBuyer(buyerLc, 50);
  const out = [];
  for (const o of rows) {
    const q = await s.repo.getQuote(o.quote_id);
    if (!q) continue;
    out.push({
      order_id: o.id,
      quote_id: o.quote_id,
      status: o.status,
      tier: o.tier,
      created_at: o.created_at,
      access_token: await accessToken(accessSecret, o.id),
      k_buyer: q.delivery === "private" ? await deriveKBuyer(kmaster, q.id) : null,
      status_url: `${s.cfg.publicBaseUrl}/v1/orders/${o.id}`,
      ...orderLinks(s.cfg, o),
    });
  }
  return out;
}
