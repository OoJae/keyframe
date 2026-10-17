import { KFC1_CHUNK_PLAINTEXT, type Manifest, SpecSchema, sha256Hex, termsFromJson } from "@keyframe/protocol";
import * as z from "zod/v4";
import { ASPECT_SIZE, FPS } from "../catalog.js";
import type { JobKind, JobRow, OrderRow, QuoteRow } from "../db/rows.js";
import { checkChunk, checkManifest, checkPreview, checkStill, verifyStored } from "../delivery/artifacts.js";
import { fileKey, quoteKeys, rawFileKey } from "../delivery/keys.js";
import { error, json } from "../http.js";
import { touchRenderWorker } from "../liveness.js";
import { encodeFactoryCall, runAction, studioWindows } from "../orders/lifecycle.js";
import { finalizeInstantQuote, JOB_ID } from "../quotes/service.js";
import { termsOf } from "../quotes/view.js";
import { nowS, type Services } from "../services.js";
import { keys } from "../storage.js";

// Render-worker / Studio-CLI API (bearer WORKER_TOKEN, plus X-Worker-Id on job calls). A job hands out exactly
// the inputs for one render, including K_file for that file only; uploads are validated byte-for-byte; `done`
// re-verifies everything from public storage before the quote turns final (Instant) or the delivery goes
// on-chain (Studio).

export const LEASE_S = 600;
export const STUDIO_LEASE_S = 24 * 3600;
const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

export const ClaimBody = z.object({
  worker_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  kinds: z
    .array(z.enum(["instant_render", "studio_delivery"]))
    .min(1)
    .optional(),
});

export const DoneBody = z.object({
  template: z
    .strictObject({ id: z.string().min(1).max(64), version: z.string().min(1).max(64), hash: Hex32 })
    .optional(),
  renderer: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(64) }).optional(),
  keyframe_at_ms: z.int().min(0).max(120_000).optional(),
});

export const FailedBody = z.object({ error: z.string().min(1).max(500), retryable: z.boolean().default(true) });

/** Per-attempt artifact tag: first 8 hex of the job id + attempt number. */
export const artifactTag = (job: Pick<JobRow, "id" | "attempts">) => `${job.id.slice(2, 10)}-${job.attempts}`;

const uploadPaths = (id: string) => ({
  still: `/internal/jobs/${id}/still`,
  preview: `/internal/jobs/${id}/preview`,
  manifest: `/internal/jobs/${id}/manifest`,
  chunk: `/internal/jobs/${id}/chunks/{i}`,
  heartbeat: `/internal/jobs/${id}/heartbeat`,
  done: `/internal/jobs/${id}/done`,
  failed: `/internal/jobs/${id}/failed`,
});

/** Everything the worker needs for one job. */
export async function jobInputs(s: Services, job: JobRow, q: QuoteRow) {
  const { kmaster } = s.cfg.secrets;
  if (!kmaster) throw new Error("KMASTER not configured");
  const spec = SpecSchema.parse(JSON.parse(q.spec_json));
  const salt = termsFromJson(JSON.parse(q.terms_json)).salt;
  const { kChain, kBuyer } = await quoteKeys(kmaster, q);
  const size = ASPECT_SIZE[spec.aspect];
  return {
    job_id: job.id,
    kind: job.kind,
    attempt: job.attempts,
    lease_expires_at: job.lease_expires_at,
    quote_id: q.id,
    order_id: job.order_id,
    template:
      job.kind === "instant_render"
        ? { id: spec.template.id, catalog_id: q.catalog_id, format: spec.format, style: spec.style }
        : null,
    output: {
      mime: "video/mp4",
      aspect: spec.aspect,
      width: size.width,
      height: size.height,
      duration_s: spec.durationS,
      fps: FPS,
      hero_ms: q.hero_ms,
      faststart: true,
    },
    params: spec.params,
    data_snapshot: q.data_snapshot ? JSON.parse(q.data_snapshot) : null,
    watermark: { text: `KEYFRAME · PREVIEW · ${q.id}` },
    kfc1: {
      alg: "KFC1",
      salt,
      k_file: await rawFileKey(kChain, kBuyer, salt),
      chunk_size: KFC1_CHUNK_PLAINTEXT,
      nonce: "0x00000000 ‖ u64be(i)",
      aad: 'utf8("KFC1") ‖ salt ‖ u64be(i) ‖ u64be(n)',
    },
    requires:
      job.kind === "instant_render" ? ["still", "preview", "manifest", "chunks"] : ["preview", "manifest", "chunks"],
    upload: uploadPaths(job.id),
  };
}

export async function claim(s: Services, workerId: string, kinds: readonly JobKind[]): Promise<Response> {
  const now = nowS(s);
  // Only a worker that takes Instant renders keeps the render studio "online" (liveness.ts).
  if (kinds.includes("instant_render")) await touchRenderWorker(s, workerId);
  const job = await s.repo.claimJob(workerId, kinds, now, LEASE_S);
  if (!job) return new Response(null, { status: 204 });
  const q = await s.repo.getQuote(job.quote_id);
  if (!q) return error(409, { error: "job_without_quote" });
  s.log.info("job_claimed", { job_id: job.id, quote_id: q.id, worker_id: workerId, attempt: job.attempts });
  return json(200, await jobInputs(s, job, q));
}

/** Loads a job the caller holds (claimed, lease valid, same worker). */
export async function heldJob(
  s: Services,
  id: string,
  workerId: string | undefined,
): Promise<{ job: JobRow; quote: QuoteRow } | Response> {
  const job = await s.repo.getJob(id);
  if (!job) return error(404, { error: "unknown_job" });
  if (job.status !== "claimed") return error(409, { error: "job_not_claimed", status: job.status });
  if (!workerId || job.worker_id !== workerId) return error(403, { error: "job_held_by_another_worker" });
  if ((job.lease_expires_at ?? 0) < nowS(s)) return error(409, { error: "lease_expired" });
  const quote = await s.repo.getQuote(job.quote_id);
  if (!quote) return error(409, { error: "job_without_quote" });
  return { job, quote };
}

export async function heartbeat(s: Services, job: JobRow, progress: number | null): Promise<Response> {
  const lease = job.kind === "studio_delivery" ? STUDIO_LEASE_S : LEASE_S;
  const ok = await s.repo.heartbeatJob(job.id, job.worker_id ?? "", progress, nowS(s), lease);
  // A busy render worker stops polling; its job heartbeats keep it online. Studio CLI deliveries do not count.
  if (job.kind === "instant_render" && job.worker_id) await touchRenderWorker(s, job.worker_id);
  return ok ? json(200, { ok: true, lease_expires_at: nowS(s) + lease }) : error(409, { error: "job_not_claimed" });
}

export async function putStill(s: Services, job: JobRow, q: QuoteRow, bytes: Uint8Array, type: string) {
  const c = checkStill(bytes, type);
  if (!c.ok) return error(422, { error: c.error });
  const key = keys.still(q.id, artifactTag(job), c.value);
  await s.storage.put(key, bytes, type.split(";")[0] ?? type);
  const sha256 = await sha256Hex(bytes);
  const url = `${s.cfg.filesBaseUrl}/${key}`;
  await s.repo.setJobArtifact(job.id, "still", key, sha256, nowS(s));
  if (job.kind === "instant_render") await s.repo.setQuoteStill(q.id, url, sha256, nowS(s));
  return json(200, { sha256, url });
}

export async function putPreview(s: Services, job: JobRow, q: QuoteRow, bytes: Uint8Array, type: string) {
  const c = checkPreview(bytes, type);
  if (!c.ok) return error(422, { error: c.error });
  const key = keys.preview(q.id, artifactTag(job));
  await s.storage.put(key, bytes, "video/mp4");
  const sha256 = await sha256Hex(bytes);
  const url = `${s.cfg.filesBaseUrl}/${key}`;
  await s.repo.setJobArtifact(job.id, "preview", key, sha256, nowS(s));
  if (job.kind === "instant_render") await s.repo.setQuotePreview(q.id, url, nowS(s));
  return json(200, { sha256, url });
}

export async function putManifest(s: Services, job: JobRow, q: QuoteRow, raw: unknown) {
  const spec = SpecSchema.parse(JSON.parse(q.spec_json));
  const salt = termsOf(q).salt;
  const c = await checkManifest(raw, spec, salt);
  if (!c.ok) return error(422, { error: c.error });
  const { manifestHash, canonical } = c.value;
  if (!(await s.repo.setJobManifest(job.id, canonical, manifestHash, nowS(s)))) {
    return error(409, { error: "manifest_already_set", manifest_hash: job.manifest_hash });
  }
  await s.storage.put(keys.manifest(manifestHash), new TextEncoder().encode(canonical), "application/json");
  return json(200, {
    manifest_hash: manifestHash,
    manifest_url: `${s.cfg.filesBaseUrl}/${keys.manifest(manifestHash)}`,
  });
}

async function jobKey(s: Services, q: QuoteRow): Promise<{ key: CryptoKey; salt: `0x${string}` }> {
  const { kmaster } = s.cfg.secrets;
  if (!kmaster) throw new Error("KMASTER not configured");
  const salt = termsOf(q).salt;
  const { kChain, kBuyer } = await quoteKeys(kmaster, q);
  return { key: await fileKey(kChain, kBuyer, salt), salt };
}

export async function putChunk(s: Services, job: JobRow, q: QuoteRow, idx: number, bytes: Uint8Array) {
  if (!job.manifest_json || !job.manifest_hash) return error(409, { error: "upload_manifest_first" });
  const m = JSON.parse(job.manifest_json) as Manifest;
  const { key, salt } = await jobKey(s, q);
  const c = await checkChunk(bytes, idx, m, key, salt);
  if (!c.ok) return error(422, { error: c.error, index: idx });
  await s.storage.put(keys.chunk(job.manifest_hash, idx), bytes, "application/octet-stream");
  await s.repo.putChunk(job.id, idx, c.value.sha256, nowS(s));
  return json(200, { index: idx, sha256: c.value.sha256 });
}

export async function done(s: Services, job: JobRow, q: QuoteRow, body: z.infer<typeof DoneBody>) {
  if (!job.manifest_json || !job.manifest_hash) return error(409, { error: "manifest_missing" });
  const m = JSON.parse(job.manifest_json) as Manifest;
  const have = await s.repo.chunkHashes(job.id);
  for (let i = 0; i < m.chunks; i++)
    if (have.get(i) !== m.ciphertext[i]) return error(409, { error: "chunk_missing", index: i });
  if (!job.preview_key) return error(409, { error: "preview_missing" });
  if (job.kind === "instant_render" && (!job.still_key || !job.still_sha256))
    return error(409, { error: "still_missing" });

  const { key, salt } = await jobKey(s, q);
  const verified = await verifyStored(s.storage, m, job.manifest_hash as `0x${string}`, key, salt);
  if (!verified.ok) {
    await s.repo.failJob(job.id, `self_verify: ${verified.error}`, true, nowS(s));
    return error(422, { error: "self_verify_failed", detail: verified.error });
  }

  if (job.kind === "instant_render") {
    const spec = SpecSchema.parse(JSON.parse(q.spec_json));
    if (!body.template || !body.renderer) return error(400, { error: "template_and_renderer_required" });
    if (body.template.id !== spec.template.id)
      return error(422, { error: "template_mismatch", expected: spec.template.id });
    const final = await finalizeInstantQuote(s, q, {
      template: body.template as { id: string; version: string; hash: `0x${string}` },
      renderer: body.renderer,
      keyframeAtMs: body.keyframe_at_ms ?? q.hero_ms,
      stillSha256: job.still_sha256 as `0x${string}`,
      manifestHash: job.manifest_hash as `0x${string}`,
    });
    if (!final) return error(409, { error: "quote_not_draft", status: q.status });
    await s.repo.completeJob(job.id, nowS(s));
    return json(200, {
      job_id: job.id,
      quote_id: q.id,
      status: "final",
      manifest_hash: final.manifest_hash,
      terms_hash: final.terms_hash,
      escrow: final.escrow,
    });
  }
  return studioDelivered(s, job, q, job.manifest_hash);
}

/** The one revision after a change request: still in review on-chain, no revision yet, before accept_by. */
export function revisionOpen(order: OrderRow, q: QuoteRow, now: number): boolean {
  if (order.tier !== "studio" || order.status !== "delivered") return false;
  if (order.change_requested_at === null || order.change_requested_at === undefined) return false;
  if ((order.revision_delivered_at ?? null) !== null || order.accepted === 1 || order.buyer_accepted_at) return false;
  return now < studioWindows(order, termsOf(q)).acceptBy;
}

async function studioDelivered(s: Services, job: JobRow, q: QuoteRow, manifestHash: string) {
  const order = job.order_id ? await s.repo.getOrder(job.order_id) : null;
  if (order && revisionOpen(order, q, nowS(s))) {
    // The contract knows one deliver; the revision is recorded off-chain and released only on an explicit accept.
    const now = nowS(s);
    const previewUrl = `${s.cfg.filesBaseUrl}/${job.preview_key}`;
    await s.repo.updateOrder(
      order.id,
      { revision_manifest_hash: manifestHash, revision_preview_url: previewUrl, revision_delivered_at: now },
      now,
    );
    await s.repo.completeJob(job.id, now);
    s.log.info("studio_revision_delivered", { order_id: order.id, manifest_hash: manifestHash });
    return json(200, {
      job_id: job.id,
      order_id: order.id,
      manifest_hash: manifestHash,
      tx: null,
      state: "revision_delivered",
      revision: true,
    });
  }
  if (order?.status !== "sealed") return error(409, { error: "order_not_deliverable", status: order?.status ?? null });
  const now = nowS(s);
  if (now > order.deadline) return error(409, { error: "deadline_passed", deadline: order.deadline });
  const previewUrl = `${s.cfg.filesBaseUrl}/${job.preview_key}`;
  await s.repo.setStudioPreview(q.id, previewUrl, now);
  await s.repo.updateOrder(order.id, { manifest_hash: manifestHash }, now);
  const t = termsOf(q);
  const r = await runAction(
    s,
    { ...order, manifest_hash: manifestHash },
    "deliver",
    encodeFactoryCall.deliver(t, manifestHash as `0x${string}`),
    8_000,
  );
  if (r.state === "busy") return error(409, { error: "order_busy" });
  if (r.state !== "confirmed" && r.state !== "pending") {
    return error(502, { error: "deliver_failed", detail: r.reason });
  }
  await s.repo.completeJob(job.id, now);
  return json(200, { job_id: job.id, order_id: order.id, manifest_hash: manifestHash, tx: r.hash, state: r.state });
}

export async function failed(s: Services, job: JobRow, q: QuoteRow, body: z.infer<typeof FailedBody>) {
  const now = nowS(s);
  const status = await s.repo.failJob(job.id, body.error, body.retryable, now);
  if (status === "failed" && job.kind === "instant_render") await s.repo.cancelQuote(q.id, "render_failed", now);
  s.log.warn("job_failed", { job_id: job.id, quote_id: q.id, status, retryable: body.retryable });
  return json(200, { job_id: job.id, status });
}

/** Studio CLI: open a delivery job for a paid Studio order (held by the caller for 24 h). */
export async function openStudioDelivery(s: Services, order: OrderRow, workerId: string): Promise<Response> {
  const q = await s.repo.getQuote(order.quote_id);
  if (!q) return error(409, { error: "order_without_quote" });
  const now = nowS(s);
  const revision = revisionOpen(order, q, now);
  if (order.tier !== "studio" || (order.status !== "sealed" && !revision)) {
    return error(409, { error: "order_not_deliverable", status: order.status });
  }
  let job = await s.repo.activeJobForQuote(q.id);
  if (job?.status === "claimed") {
    if (job.worker_id !== workerId && (job.lease_expires_at ?? 0) >= now) {
      return error(409, { error: "delivery_job_held_by_another_worker" });
    }
    if (job.worker_id === workerId) return json(200, await jobInputs(s, job, q));
  }
  if (!job) {
    const id = JOB_ID();
    await s.repo.insertJob({ id, kind: "studio_delivery", quote_id: q.id, order_id: order.id, max_attempts: 5 }, now);
    job = await s.repo.getJob(id);
  }
  const held = job ? await s.repo.claimJobById(job.id, workerId, now, STUDIO_LEASE_S) : null;
  if (!held) return error(409, { error: "delivery_job_busy" });
  return json(200, await jobInputs(s, held, q));
}

export async function cancelStudioOrder(s: Services, order: OrderRow): Promise<Response> {
  if (order.tier !== "studio" || !["sealed", "funding"].includes(order.status)) {
    return error(409, { error: "order_not_cancellable", status: order.status });
  }
  const q = await s.repo.getQuote(order.quote_id);
  if (!q) return error(409, { error: "order_without_quote" });
  const r = await runAction(s, order, "cancel", encodeFactoryCall.cancel(termsOf(q)), 8_000);
  if (r.state === "confirmed" || r.state === "pending")
    return json(200, { order_id: order.id, tx: r.hash, state: r.state });
  return error(r.state === "busy" ? 409 : 502, { error: "cancel_failed", detail: r.reason ?? r.state });
}
