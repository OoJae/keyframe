import { newQuoteId, type Spec, SpecSchema, termsToJson } from "@keyframe/protocol";
import { type Address, getAddress, type Hex } from "viem";
import { MAX_KILL_FEE_BPS, MAX_REVIEW_WINDOW_S } from "../config.js";
import type { QuoteRow } from "../db/rows.js";
import { error, json } from "../http.js";
import { nowS, type Services } from "../services.js";
import {
  buildSpec,
  deriveQuoteKeys,
  initialTemplate,
  type PlanError,
  planQuote,
  seal,
  snapshotHash,
  ZERO32,
} from "./build.js";
import { checkPolicy } from "./policy.js";
import { parseQuoteRequest } from "./request.js";
import { quoteView, termsOf } from "./view.js";

// POST /v1/quotes and GET /v1/quotes/{id}. Instant quotes start as provisional drafts and become final when the
// render worker has delivered the encrypted master (render-before-pay, contentHash = manifestHash). Studio quotes
// are final immediately (contentHash = 0, bound at delivery).

export const RENDER_MAX_ATTEMPTS = 3;
export const JOB_ID = () => `j_${crypto.randomUUID().replace(/-/g, "")}`;

const planError = (p: PlanError) => error(p.status, { error: p.error, detail: p.detail });

/**
 * `client` is the hashed caller bucket (see ratelimit.ts clientKey): Instant renders are capped per client and in
 * total, and the worker claims them round-robin across clients, so junk quotes cannot starve real buyers.
 */
export async function createQuote(s: Services, body: unknown, client = "local"): Promise<Response> {
  const { cfg } = s;
  if (cfg.maintenance) return error(503, { error: "maintenance", detail: "new orders are paused" });
  if (cfg.problems.length > 0 || !cfg.operator || !cfg.secrets.kmaster) {
    return error(503, { error: "server_misconfigured", detail: "quoting is unavailable" });
  }
  const parsed = parseQuoteRequest(body);
  if (!parsed.ok) return error(400, { error: parsed.error, issues: parsed.issues });
  const req = parsed.request;
  const now = nowS(s);

  const policy = checkPolicy(req, now, cfg.policyDenylist);
  if (!policy.ok) {
    return error(422, {
      error: "content_policy",
      reason: policy.reason,
      field: policy.field,
      detail: `${policy.field}: ${policy.reason.replace(/_/g, " ")}`,
    });
  }
  const plan = planQuote(req, cfg, now);
  if (!plan.ok) return planError(plan);
  if (plan.tier === "instant" && plan.deadlineMinutes * 60 < cfg.minReleaseMarginS) {
    return error(422, {
      error: "deadline_too_short",
      detail: `deadline_minutes must be at least ${Math.ceil(cfg.minReleaseMarginS / 60)} on this deployment`,
    });
  }

  const buyer = getAddress(req.buyer);
  const buyerLc = buyer.toLowerCase();
  if ((await s.repo.countQuotesByBuyerSince(buyerLc, now - 3600)) >= cfg.quotesPerBuyerPerHour) {
    return error(429, { error: "rate_limited", detail: "too many quotes for this buyer" }, { "Retry-After": "600" });
  }
  const screening = await s.sanctions.screen(buyer);
  if (screening === "sanctioned") return error(451, { error: "sanctioned", detail: "this address cannot be served" });
  if (screening === "unavailable") return error(503, { error: "screening_unavailable", detail: "try again later" });
  if (plan.tier === "instant") {
    const queue = await s.repo.renderQueue(client);
    if (queue.owner >= cfg.maxQueuedRendersPerClient) {
      return error(
        429,
        { error: "render_queue_limit", detail: "too many previews rendering for this client; wait for them to finish" },
        { "Retry-After": "60" },
      );
    }
    if (queue.total >= cfg.maxQueuedRenders) {
      return error(
        503,
        { error: "render_queue_full", detail: "the render queue is full; try again shortly" },
        { "Retry-After": "60" },
      );
    }
  }

  const quoteId = newQuoteId();
  const keys = await deriveQuoteKeys(cfg.secrets.kmaster, quoteId, plan.delivery === "private");
  const snapshotSha = plan.dataSnapshot !== null ? await snapshotHash(plan.dataSnapshot) : null;
  const studio = plan.tier === "studio";
  const spec = buildSpec({
    plan,
    seller: cfg.seller,
    kBuyerHash: keys.kBuyerHash,
    dataSnapshotSha256: snapshotSha,
    keyframe: null,
    ...initialTemplate(plan),
  });
  const quoteExpiresAt = now + (studio ? cfg.quoteTtlS : cfg.draftTtlS);
  const deadline = quoteExpiresAt + (studio ? plan.item.etaS : plan.deadlineMinutes * 60);
  const sealed = await seal(
    spec,
    {
      buyer,
      seller: cfg.seller,
      operator: cfg.operator,
      token: cfg.usdc,
      amount: plan.amount,
      deadline,
      reviewWindow: studio ? cfg.studioReviewS : 0,
      killFeeBps: studio ? cfg.studioKillFeeBps : 0,
      keyHash: keys.keyHash,
      contentHash: ZERO32,
      salt: keys.salt,
    },
    cfg,
  );
  if (sealed.terms.reviewWindow > MAX_REVIEW_WINDOW_S || sealed.terms.killFeeBps > MAX_KILL_FEE_BPS) {
    return error(503, { error: "server_misconfigured", detail: "studio terms are outside the factory's bounds" });
  }

  const row: QuoteRow = {
    id: quoteId,
    status: studio ? "final" : "draft",
    tier: plan.tier,
    format: plan.specFormat,
    catalog_id: plan.item.id,
    buyer,
    buyer_lc: buyerLc,
    amount: plan.amount.toString(),
    delivery: plan.delivery,
    hero_ms: plan.heroMs,
    spec_json: JSON.stringify(sealed.spec),
    spec_hash: sealed.specHash,
    terms_json: JSON.stringify(termsToJson(sealed.terms)),
    terms_hash: sealed.termsHash,
    escrow: sealed.escrow,
    data_snapshot: plan.dataSnapshot !== null ? JSON.stringify(plan.dataSnapshot) : null,
    still_url: null,
    still_sha256: null,
    preview_url: null,
    manifest_hash: null,
    eta_s: plan.item.etaS,
    quote_expires_at: quoteExpiresAt,
    deadline,
    pay_from: null,
    pay_nonce: null,
    order_id: null,
    cancel_reason: null,
    created_at: now,
    finalized_at: studio ? now : null,
    updated_at: now,
    client_key: client,
  };
  await s.repo.createQuote(
    row,
    studio ? null : { id: JOB_ID(), kind: "instant_render", order_id: null, max_attempts: RENDER_MAX_ATTEMPTS },
  );
  s.log.info("quote_created", { quote_id: quoteId, catalog_id: plan.item.id, tier: plan.tier, status: row.status });
  return json(201, quoteView(row, cfg, now));
}

export async function getQuote(s: Services, quoteId: string): Promise<Response> {
  const q = await s.repo.getQuote(quoteId);
  if (!q) return error(404, { error: "unknown_quote" });
  return json(200, quoteView(q, s.cfg, nowS(s)));
}

export interface RenderReport {
  template: { id: string; version: string; hash: Hex };
  renderer: { name: string; version: string };
  keyframeAtMs: number;
  stillSha256: Hex;
  manifestHash: Hex;
}

/**
 * draft → final once the encrypted master is verified: the spec gains the approved key frame and what rendered
 * it, T.contentHash = manifestHash, and the payment window starts now. The delivery window chosen at quote time
 * (deadline − expiry) is preserved.
 */
export async function finalizeInstantQuote(s: Services, q: QuoteRow, r: RenderReport): Promise<QuoteRow | null> {
  const { cfg } = s;
  if (!cfg.operator) return null;
  const spec0 = SpecSchema.parse(JSON.parse(q.spec_json));
  const spec: Spec = SpecSchema.parse({
    ...spec0,
    template: r.template,
    renderer: r.renderer,
    keyframe: { stillSha256: r.stillSha256, atMs: r.keyframeAtMs },
  });
  const t0 = termsOf(q);
  const now = nowS(s);
  const quoteExpiresAt = now + cfg.quoteTtlS;
  const deadline = quoteExpiresAt + (q.deadline - q.quote_expires_at);
  const sealed = await seal(
    spec,
    {
      buyer: t0.buyer,
      seller: cfg.seller,
      operator: cfg.operator as Address,
      token: cfg.usdc,
      amount: t0.amount,
      deadline,
      reviewWindow: 0,
      killFeeBps: 0,
      keyHash: t0.keyHash,
      contentHash: r.manifestHash,
      salt: t0.salt,
    },
    cfg,
  );
  const patch = {
    spec_json: JSON.stringify(sealed.spec),
    spec_hash: sealed.specHash,
    terms_json: JSON.stringify(termsToJson(sealed.terms)),
    terms_hash: sealed.termsHash,
    escrow: sealed.escrow,
    manifest_hash: r.manifestHash,
    eta_s: 15,
    quote_expires_at: quoteExpiresAt,
    deadline,
  };
  if (!(await s.repo.finalizeQuote(q.id, patch, now))) return null;
  s.log.info("quote_final", { quote_id: q.id, terms_hash: sealed.termsHash, escrow: sealed.escrow });
  return { ...q, ...patch, status: "final", finalized_at: now, updated_at: now };
}
