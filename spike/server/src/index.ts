// Keyframe DAY-1 interop spike server (Hono on Cloudflare Workers).
//
// Routes:
//   GET  /health
//   POST /v1/spike/quotes            {buyer, amount}  -> per-quote codeless HD payee (Bearer SPIKE_ADMIN_TOKEN if set)
//   GET  /v1/quotes/:id
//   ALL  /v1/orders/:id              x402 resource (402 challenge, paid 200, replay, 409)
//   GET  /v1/diag/blob?bytes=N       N deterministic bytes (N <= 10 MiB)
//   GET  /v1/diag/log?quote_id=...   request log for /v1/orders/* (no secrets)
//
// No CORS headers are emitted (browsers cannot call this cross-origin). Secrets are never echoed or logged.

import { Hono } from "hono";
import type { Context } from "hono";
import { getAddress, isAddress } from "viem";
import * as z from "zod/v4";

import { type Config, type Env, MIN_AMOUNT_ATOMIC, NETWORK_V2, readConfig } from "./env.js";
import { deriveSpikePayee } from "./hd.js";
import { canonicalJson, newOrderId, newQuoteId, QUOTE_ID_RE, randomHex, sha256Hex } from "./ids.js";
import {
  allocatePayeeIndex,
  clearSettling,
  clip,
  getPaid,
  getQuote,
  getSettled,
  getSettling,
  getStoredResponse,
  type LogEntry,
  logKeyBase,
  putPaid,
  putQuote,
  putSettled,
  putSettling,
  putStoredResponse,
  readLog,
  writeLog,
} from "./store.js";
import {
  type DecodedPayment,
  decodePaymentHeaders,
  getX402Runtime,
  makeContext,
  ordersPath,
  SpikeAdapter,
  type StoredQuote,
  tolerantV2Header,
  utf8ToBase64,
  v1PaymentRequiredBody,
  v1Requirements,
} from "./x402.js";

const SERVER_VERSION = "keyframe-spike/0.1.0";

interface LogDraft {
  keyBase: string;
  entry: LogEntry;
  started: number;
}
type AppEnv = { Bindings: Env; Variables: { log: LogDraft | undefined } };

const app = new Hono<AppEnv>();

// ------------------------------------------------------------------ helpers

function waitUntil(c: Context<AppEnv>, p: Promise<unknown>): void {
  const guarded = p.catch((e: unknown) => console.error("background task failed:", e instanceof Error ? e.name : "error"));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    void guarded; // local Node run: no ExecutionContext, the promise just runs
  }
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const requestSignal = (c: Context<AppEnv>): AbortSignal | undefined => c.req.raw.signal ?? undefined;

// ------------------------------------------------------------------ health

app.get("/health", (c) => {
  const cfg = readConfig(c.env);
  return c.json({
    ok: true,
    version: SERVER_VERSION,
    x402_mode: cfg.mode,
    settle_mode: cfg.settleMode,
    paid_delay_ms: cfg.paidDelayMs,
    public_base_url: cfg.publicBaseUrl,
    facilitator: cfg.facilitatorUrl,
    max_amount_atomic: cfg.maxAmountAtomic.toString(),
    paid_body_pad_bytes: cfg.paidBodyPadBytes,
    mnemonic_configured: Boolean(c.env.SPIKE_MNEMONIC),
    admin_token_required: Boolean(c.env.SPIKE_ADMIN_TOKEN),
    kv_bound: Boolean(c.env.SPIKE_KV),
  });
});

// ------------------------------------------------------------------ quotes

const QuoteRequest = z
  .object({
    buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    amount: z.string().regex(/^[1-9][0-9]{5,9}$/),
  })
  .strict();

app.post("/v1/spike/quotes", async (c) => {
  const cfg = readConfig(c.env);
  if (c.env.SPIKE_ADMIN_TOKEN) {
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!presented || !(await timingSafeEqual(presented, c.env.SPIKE_ADMIN_TOKEN))) {
      return jsonResponse(401, { error: "unauthorized" });
    }
  }
  if (!c.env.SPIKE_MNEMONIC) return jsonResponse(503, { error: "server_misconfigured", detail: "SPIKE_MNEMONIC secret is not set" });
  if (!cfg.publicBaseUrl) return jsonResponse(503, { error: "server_misconfigured", detail: "PUBLIC_BASE_URL is not a valid https origin" });
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return jsonResponse(415, { error: "content_type_must_be_application_json" });
  }
  const text = await c.req.text();
  if (text.length > 2048) return jsonResponse(413, { error: "body_too_large" });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const parsed = QuoteRequest.safeParse(parsedJson);
  if (!parsed.success) {
    return jsonResponse(400, {
      error: "invalid_request",
      detail: "expected {buyer: 0x-address, amount: atomic USDC string}",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const { buyer, amount } = parsed.data;
  if (!isAddress(buyer, { strict: true })) return jsonResponse(400, { error: "invalid_buyer", detail: "bad EIP-55 checksum" });
  const atomic = BigInt(amount);
  if (atomic < MIN_AMOUNT_ATOMIC || atomic > cfg.maxAmountAtomic) {
    return jsonResponse(400, {
      error: "amount_out_of_range",
      min: MIN_AMOUNT_ATOMIC.toString(),
      max: cfg.maxAmountAtomic.toString(),
    });
  }
  const quoteId = newQuoteId();
  const index = await allocatePayeeIndex(c.env.SPIKE_KV, quoteId);
  const payTo = await deriveSpikePayee(c.env.SPIKE_MNEMONIC, index);
  const quote: StoredQuote = {
    quote_id: quoteId,
    pay_to: payTo,
    pay_to_index: index,
    amount: atomic.toString(),
    buyer: getAddress(buyer),
    created_at: new Date().toISOString(),
  };
  await putQuote(c.env.SPIKE_KV, quote);
  return jsonResponse(201, { ...quote, order_url: `${cfg.publicBaseUrl}${ordersPath(quoteId)}` });
});

app.get("/v1/quotes/:id", async (c) => {
  const id = c.req.param("id");
  if (!QUOTE_ID_RE.test(id)) return jsonResponse(404, { error: "unknown_quote" });
  const cfg = readConfig(c.env);
  const quote = await getQuote(c.env.SPIKE_KV, id);
  if (!quote) return jsonResponse(404, { error: "unknown_quote" });
  const paid = await getPaid(c.env.SPIKE_KV, id);
  return jsonResponse(200, {
    ...quote,
    order_url: cfg.publicBaseUrl ? `${cfg.publicBaseUrl}${ordersPath(id)}` : null,
    status: paid ? "paid" : "awaiting_payment",
    order_id: paid?.order_id ?? null,
  });
});

// ------------------------------------------------------------------ diagnostics

const BLOB_MAX = 10 * 1024 * 1024;
const BLOB_CHUNK = (() => {
  const chunk = new Uint8Array(251 * 256); // multiple of 251, so every full chunk is identical
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
  return chunk;
})();

app.get("/v1/diag/blob", (c) => {
  const raw = c.req.query("bytes") ?? "";
  if (!/^\d{1,8}$/.test(raw) || Number(raw) > BLOB_MAX) {
    return jsonResponse(400, { error: "bytes must be an integer between 0 and 10485760" });
  }
  const total = Number(raw);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(BLOB_CHUNK.length, total - sent);
      controller.enqueue(n === BLOB_CHUNK.length ? BLOB_CHUNK.slice() : BLOB_CHUNK.slice(0, n));
      sent += n;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(total),
      "Cache-Control": "no-store",
      "X-Blob-Pattern": "byte[i] = i mod 251",
    },
  });
});

app.get("/v1/diag/log", async (c) => {
  const qid = c.req.query("quote_id") ?? "";
  const bucket = qid === "_other" ? "_other" : QUOTE_ID_RE.test(qid) ? qid : null;
  if (!bucket) return jsonResponse(400, { error: "quote_id must be q_ + 22 base58 chars (or _other)" });
  const entries = await readLog(c.env.SPIKE_KV, bucket);
  const unpaid402 = entries.filter((e) => e.status === 402 && e.payment_header_name === null && e.payment_required_sha256);
  const distinct402 = [...new Set(unpaid402.map((e) => e.payment_required_sha256))];
  const [paid, settled] = bucket === "_other" ? [null, null] : await Promise.all([getPaid(c.env.SPIKE_KV, bucket), getSettled(c.env.SPIKE_KV, bucket)]);
  return jsonResponse(200, {
    quote_id: bucket,
    count: entries.length,
    unpaid_402_count: unpaid402.length,
    distinct_unpaid_402_payment_required_sha256: distinct402,
    deterministic_402: distinct402.length <= 1,
    order: paid ? { ...paid, deferred_settlement: settled } : null,
    entries,
    note: "KV is eventually consistent: entries can take up to ~60 s to appear from other locations.",
  });
});

// ------------------------------------------------------------------ orders (x402)

app.use("/v1/orders/*", async (c, next) => {
  const started = Date.now();
  const segments = c.req.path.split("/");
  const maybeId = segments[3] ?? "";
  const qid = segments.length === 4 && QUOTE_ID_RE.test(maybeId) ? maybeId : null;
  const cfg = readConfig(c.env);
  const decoded = decodePaymentHeaders(c.req.raw.headers);
  // The order resource is keyed by URL only; the body is never parsed, just measured (bounded) for the log.
  let bodyBytes: number | null = 0;
  try {
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyBytes = (bodyBytes ?? 0) + value.byteLength;
        if (bodyBytes > 65_536) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } catch {
    bodyBytes = null;
  }
  const draft: LogDraft = {
    keyBase: logKeyBase(qid),
    started,
    entry: {
      ts: new Date(started).toISOString(),
      method: c.req.method,
      path: clip(c.req.path, 120) ?? "",
      ua: clip(c.req.header("user-agent")),
      accept: clip(c.req.header("accept")),
      content_length: clip(c.req.header("content-length") ?? null, 20),
      body_bytes: bodyBytes,
      payment_header_name: decoded.headerName,
      x402_version_of_payload: decoded.version,
      payment_required_sha256: null,
      payment_required_source: null,
      status: 0,
      ms: 0,
      wire: cfg.mode,
      note: null,
    },
  };
  c.set("log", draft);
  if (decoded.headerName) {
    // Paid attempts get an "in flight" entry first, so a request the runtime cancels (client gone) still shows up.
    draft.entry.note = "in_flight";
    waitUntil(c, writeLog(c.env.SPIKE_KV, draft.keyBase, "a", { ...draft.entry }));
    draft.entry.note = null;
  }
  await next();
  draft.entry.status = c.res.status;
  draft.entry.ms = Date.now() - started;
  const pr = c.res.headers.get("payment-required");
  if (pr && !draft.entry.payment_required_sha256) {
    draft.entry.payment_required_sha256 = await sha256Hex(pr);
    draft.entry.payment_required_source = "header";
  }
  waitUntil(c, writeLog(c.env.SPIKE_KV, draft.keyBase, "b", draft.entry));
});

function note(c: Context<AppEnv>, text: string): void {
  const draft = c.get("log");
  if (draft) draft.entry.note = draft.entry.note ? `${draft.entry.note};${text}` : text;
}

app.all("/v1/orders/:id", async (c) => {
  const id = c.req.param("id");
  if (!QUOTE_ID_RE.test(id)) return jsonResponse(404, { error: "unknown_quote" });
  const cfg = readConfig(c.env);
  if (!cfg.publicBaseUrl) return jsonResponse(503, { error: "server_misconfigured", detail: "PUBLIC_BASE_URL" });
  const quote = await getQuote(c.env.SPIKE_KV, id);
  if (!quote) return jsonResponse(404, { error: "unknown_quote" });
  const canonicalUrl = `${cfg.publicBaseUrl}${ordersPath(id)}`;
  const decoded = decodePaymentHeaders(c.req.raw.headers);

  if (!decoded.headerName) {
    const paid = await getPaid(c.env.SPIKE_KV, id);
    if (paid) return jsonResponse(409, { error: "quote_already_paid", quote_id: id, order_id: paid.order_id });
    return unpaidChallenge(c, cfg, quote, canonicalUrl);
  }

  // ---- paid attempt
  if (decoded.from && decoded.nonce) {
    const replay = await getStoredResponse(c.env.SPIKE_KV, decoded.from, decoded.nonce);
    if (replay && replay.quote_id === id) {
      note(c, "idempotent_replay");
      return new Response(replay.body, { status: replay.status, headers: replay.headers });
    }
  }
  const paid = await getPaid(c.env.SPIKE_KV, id);
  if (paid) {
    note(c, "already_paid_different_nonce");
    return jsonResponse(409, { error: "quote_already_paid", quote_id: id, order_id: paid.order_id, detail: "not charged" });
  }
  const settling = await getSettling(c.env.SPIKE_KV, id);
  if (settling) {
    note(c, "settlement_in_progress");
    return jsonResponse(409, { error: "settlement_in_progress", quote_id: id, detail: "retry shortly; not charged twice" });
  }

  const signal = requestSignal(c);
  if (cfg.paidDelayMs > 0) {
    note(c, `paid_delay_ms=${cfg.paidDelayMs}`);
    await sleep(cfg.paidDelayMs, signal);
    if (signal?.aborted) {
      note(c, "client_aborted_before_verify;not_settled");
      return jsonResponse(499, { error: "client_closed_request", detail: "not verified, not settled" });
    }
  }

  const wire = decoded.version === 1 ? "v1" : "v2";
  return wire === "v1" ? paidV1(c, cfg, quote, canonicalUrl, decoded) : paidV2(c, cfg, quote, canonicalUrl, decoded);
});

async function unpaidChallenge(c: Context<AppEnv>, cfg: Config, quote: StoredQuote, canonicalUrl: string): Promise<Response> {
  const draft = c.get("log");
  if (cfg.mode === "v1") {
    const body = v1PaymentRequiredBody(quote, canonicalUrl);
    if (draft) {
      draft.entry.payment_required_sha256 = await sha256Hex(body);
      draft.entry.payment_required_source = "body";
    }
    return new Response(body, { status: 402, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const rt = await getX402Runtime(cfg.facilitatorUrl);
  const adapter = new SpikeAdapter(c.req.raw.headers, c.req.method, quote, canonicalUrl);
  const result = await rt.http.processHTTPRequest(makeContext(adapter));
  if (result.type !== "payment-error") return jsonResponse(500, { error: "unexpected_x402_state" });
  return instructionsToResponse(result.response);
}

function instructionsToResponse(r: { status: number; headers: Record<string, string>; body?: unknown }): Response {
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
  return new Response(body, { status: r.status, headers: r.headers });
}

interface PaidContext {
  quote: StoredQuote;
  wire: "v1" | "v2";
  payer: string | null;
  from: string | null;
  nonce: string | null;
  receivedAt: string;
  cfg: Config;
}

async function buildPaidBody(p: PaidContext, orderId: string, settlementTx: string | null): Promise<string> {
  const core: Record<string, unknown> = {
    order_id: orderId,
    quote_id: p.quote.quote_id,
    pay_to: p.quote.pay_to,
    amount: p.quote.amount,
    payer: p.payer,
    settlement_tx: settlementTx,
    settlement: settlementTx ? "confirmed" : "deferred",
    network: NETWORK_V2,
    wire: p.wire,
    received_at: p.receivedAt,
  };
  if (p.cfg.paidBodyPadBytes > 0) {
    // S7 body-integrity payload: secret-shaped test value, nesting, unicode, and padding.
    core.s7 = {
      k_buyer_test: randomHex(32),
      unicode: "Ключ · 鍵 · مفتاح · 🔑",
      nested: { a: { b: { c: [1, 2, 3], d: true, e: null } } },
      pad: "x".repeat(p.cfg.paidBodyPadBytes),
    };
  }
  core.checksum = await sha256Hex(canonicalJson(core));
  return JSON.stringify(core);
}

async function finalizePaid(
  c: Context<AppEnv>,
  p: PaidContext,
  settlementTx: string | null,
  responseHeaders: Record<string, string>,
): Promise<{ orderId: string; body: string; headers: Record<string, string> }> {
  const orderId = newOrderId();
  const body = await buildPaidBody(p, orderId, settlementTx);
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, private", ...responseHeaders };
  const kv = c.env.SPIKE_KV;
  await putPaid(kv, p.quote.quote_id, {
    order_id: orderId,
    from: p.from,
    nonce: p.nonce,
    settlement_tx: settlementTx,
    wire: p.wire,
    paid_at: new Date().toISOString(),
  });
  if (p.from && p.nonce) {
    await putStoredResponse(kv, p.from, p.nonce, { quote_id: p.quote.quote_id, status: 200, body, headers });
  }
  return { orderId, body, headers };
}

async function paidV2(c: Context<AppEnv>, cfg: Config, quote: StoredQuote, canonicalUrl: string, decoded: DecodedPayment): Promise<Response> {
  const kv = c.env.SPIKE_KV;
  const signal = requestSignal(c);
  const rt = await getX402Runtime(cfg.facilitatorUrl);
  const tolerant = tolerantV2Header(decoded, quote);
  if (tolerant && tolerant.differing.length > 0) {
    note(c, `${tolerant.rewritten ? "accepted_rewritten" : "accepted_mismatch"}:${tolerant.differing.join(",").slice(0, 80)}`);
  }
  const adapter = new SpikeAdapter(c.req.raw.headers, c.req.method, quote, canonicalUrl, tolerant?.header ?? decoded.raw ?? undefined);
  const ctx = makeContext(adapter);
  const result = await rt.http.processHTTPRequest(ctx);
  if (result.type === "payment-error") {
    note(c, "verify_rejected");
    return instructionsToResponse(result.response);
  }
  if (result.type !== "payment-verified") return jsonResponse(500, { error: "unexpected_x402_state" });
  const auth = (result.paymentPayload.payload as { authorization?: { from?: string } }).authorization;
  const p: PaidContext = {
    quote,
    wire: "v2",
    payer: auth?.from ? getAddress(auth.from) : null,
    from: decoded.from,
    nonce: decoded.nonce,
    receivedAt: c.get("log")?.entry.ts ?? new Date().toISOString(),
    cfg,
  };
  if (signal?.aborted) {
    note(c, "client_aborted_after_verify;not_settled");
    await result.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 499 }).catch(() => undefined);
    return jsonResponse(499, { error: "client_closed_request", detail: "verified but not settled" });
  }
  await putSettling(kv, quote.quote_id, { from: decoded.from, nonce: decoded.nonce });

  if (cfg.settleMode === "broadcast") {
    // Deferred settle: PayAI's /settle waits for the receipt and exposes no broadcast-only call, so "broadcast"
    // here means: answer 200 right after verify and settle in the background (measures PayBox's paid-retry timeout).
    const done = await finalizePaid(c, p, null, {});
    note(c, "settle_deferred");
    waitUntil(
      c,
      (async () => {
        const s = await rt.http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: ctx });
        await putSettled(kv, quote.quote_id, s.success ? { success: true, transaction: s.transaction, at: new Date().toISOString() } : { success: false, error: s.errorReason, at: new Date().toISOString() });
        await clearSettling(kv, quote.quote_id);
      })(),
    );
    return new Response(done.body, { status: 200, headers: done.headers });
  }

  const s = await rt.http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: ctx });
  if (!s.success) {
    await clearSettling(kv, quote.quote_id);
    note(c, `settle_failed:${clip(s.errorReason, 60)}`);
    return instructionsToResponse(s.response);
  }
  const done = await finalizePaid(c, p, s.transaction, s.headers);
  await clearSettling(kv, quote.quote_id);
  note(c, "settled");
  return new Response(done.body, { status: 200, headers: done.headers });
}

async function paidV1(c: Context<AppEnv>, cfg: Config, quote: StoredQuote, canonicalUrl: string, decoded: DecodedPayment): Promise<Response> {
  const kv = c.env.SPIKE_KV;
  const signal = requestSignal(c);
  const requirements = v1Requirements(quote, canonicalUrl);
  const reject = async (error: string) => {
    note(c, `v1_rejected:${clip(error, 60)}`);
    const body = v1PaymentRequiredBody(quote, canonicalUrl, error);
    return new Response(body, { status: 402, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  };
  const payload = decoded.payload as { x402Version?: number; scheme?: string; network?: string; payload?: { authorization?: Record<string, string> } } | null;
  const auth = payload?.payload?.authorization;
  if (!payload || payload.scheme !== "exact" || payload.network !== "base" || !auth) return reject("invalid_payment_payload");
  if (typeof auth.to !== "string" || auth.to.toLowerCase() !== quote.pay_to.toLowerCase()) return reject("payto_mismatch");
  if (auth.value !== quote.amount) return reject("amount_mismatch");
  const rt = await getX402Runtime(cfg.facilitatorUrl);
  type FacilitatorArgs = Parameters<typeof rt.facilitator.verify>;
  const v1Payload = payload as unknown as FacilitatorArgs[0];
  const v1Reqs = requirements as unknown as FacilitatorArgs[1];
  let verify;
  try {
    verify = await rt.facilitator.verify(v1Payload, v1Reqs);
  } catch (e) {
    return reject(e instanceof Error ? e.message : "verify_failed");
  }
  if (!verify.isValid) return reject(verify.invalidReason ?? "invalid_payment");
  if (signal?.aborted) {
    note(c, "client_aborted_after_verify;not_settled");
    return jsonResponse(499, { error: "client_closed_request", detail: "verified but not settled" });
  }
  const p: PaidContext = {
    quote,
    wire: "v1",
    payer: verify.payer ? getAddress(verify.payer) : typeof auth.from === "string" ? getAddress(auth.from) : null,
    from: decoded.from,
    nonce: decoded.nonce,
    receivedAt: c.get("log")?.entry.ts ?? new Date().toISOString(),
    cfg,
  };
  await putSettling(kv, quote.quote_id, { from: decoded.from, nonce: decoded.nonce });
  if (cfg.settleMode === "broadcast") {
    const done = await finalizePaid(c, p, null, {});
    note(c, "settle_deferred");
    waitUntil(
      c,
      (async () => {
        const s = await rt.facilitator.settle(v1Payload, v1Reqs).catch((e: unknown) => ({ success: false, errorReason: e instanceof Error ? e.message : "settle_failed", transaction: "" }));
        await putSettled(kv, quote.quote_id, s.success ? { success: true, transaction: s.transaction, at: new Date().toISOString() } : { success: false, error: s.errorReason, at: new Date().toISOString() });
        await clearSettling(kv, quote.quote_id);
      })(),
    );
    return new Response(done.body, { status: 200, headers: done.headers });
  }
  let settle;
  try {
    settle = await rt.facilitator.settle(v1Payload, v1Reqs);
  } catch (e) {
    await clearSettling(kv, quote.quote_id);
    return reject(e instanceof Error ? e.message : "settle_failed");
  }
  if (!settle.success) {
    await clearSettling(kv, quote.quote_id);
    return reject(settle.errorReason ?? "settle_failed");
  }
  const header = utf8ToBase64(JSON.stringify(settle));
  const done = await finalizePaid(c, p, settle.transaction, { "X-PAYMENT-RESPONSE": header });
  await clearSettling(kv, quote.quote_id);
  note(c, "settled");
  return new Response(done.body, { status: 200, headers: done.headers });
}

// ------------------------------------------------------------------ fallbacks

app.notFound(() => jsonResponse(404, { error: "not_found" }));

app.onError((err) => {
  // Never include stacks or values; error names/messages here never contain secrets.
  console.error("request failed:", err.name, clip(err.message, 200));
  return jsonResponse(500, { error: "internal_error" });
});

export default app;
