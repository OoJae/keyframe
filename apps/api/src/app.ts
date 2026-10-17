import { Hono } from "hono";
import * as z from "zod/v4";
import { siweChallenge, siweVerify } from "./auth/siwe.js";
import { CATALOG, type CatalogItem, formatUsdc } from "./catalog.js";
import { publicConfig } from "./config.js";
import { llmsTxt, openApi, POLICY_NOTES } from "./discovery.js";
import { error, json, readBody, readJson, safeEqual } from "./http.js";
import {
  ClaimBody,
  cancelStudioOrder,
  claim,
  DoneBody,
  done,
  FailedBody,
  failed,
  heartbeat,
  heldJob,
  jobInputs,
  openStudioDelivery,
  putChunk,
  putManifest,
  putPreview,
  putStill,
} from "./internal/jobs.js";
import { keeperTick } from "./keeper.js";
import { renderLiveness } from "./liveness.js";
import { checkDirect } from "./orders/direct.js";
import { type Background, orderResource } from "./orders/paid.js";
import { getOrder, listOrders } from "./orders/status.js";
import { createQuote, getQuote } from "./quotes/service.js";
import { clientKey, RATE_RULES, throttle } from "./ratelimit.js";
import { errorText } from "./redact.js";
import { reviewChallenge, reviewSubmit } from "./reviews.js";
import { nowS, type Services } from "./services.js";
import { IMMUTABLE_CACHE, isPublicKey } from "./storage.js";

// HTTP surface (frozen-interfaces.md §7 plus /files and /internal). Route handlers stay thin; behaviour lives in
// the modules they call.

export const VERSION = "keyframe-api/1.0.0";
const QUOTE_ID = /^q_[1-9A-HJ-NP-Za-km-z]{22}$/;
const ORDER_ID = /^o_[1-9A-HJ-NP-Za-km-z]{22}$/;
const JOB_ID = /^j_[0-9a-f]{32}$/;

type Vars = { services: Services; background: Background; client: string };
export type AppEnv = { Bindings: object; Variables: Vars };

export interface AppHooks {
  /** Services for a request (memoised per isolate in production). */
  services: (env: object) => Services;
}

function background(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): Background {
  return (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p; // no ExecutionContext (local scripts): the promise simply runs
    }
  };
}

async function bytesOf(req: Request, max: number): Promise<Uint8Array | Response> {
  const r = await readBody(req, max);
  return r.ok ? r.bytes : r.response;
}

const hasPayment = (req: Request) => req.headers.has("payment-signature") || req.headers.has("x-payment");

/** `Authorization: Bearer <access_token>` (kept out of URLs and logs), if present. */
function bearerOf(req: Request): string | undefined {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
}

/** Review bodies may omit access_token when it is sent as a bearer token. */
function withToken(value: unknown, req: Request): unknown {
  const bearer = bearerOf(req);
  if (!bearer || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  return v.access_token === undefined ? { ...v, access_token: bearer } : v;
}

function stylesView(s: Services, tier?: string, format?: string, studioOnline = true) {
  const items = CATALOG.filter((i) => !i.hidden)
    .filter((i) => !tier || i.tier === tier)
    .filter((i) => !format || i.id === format);
  // ≤30 chars (the plugin prints it): unsellable formats, and Instant ones while the render studio is offline.
  const label = (i: CatalogItem) =>
    !i.renderable || s.cfg.formatsDisabled.has(i.id)
      ? "not available yet"
      : i.tier === "instant" && !studioOnline
        ? "studio offline"
        : null;
  return {
    v: 1,
    source: "api",
    studio: {
      seller: s.cfg.seller,
      operators: s.cfg.operator ? [s.cfg.operator] : [],
      factory: s.cfg.factory,
      vault_impl: s.cfg.vaultImpl,
    },
    formats: items.map((i) => ({
      id: i.id,
      tier: i.tier,
      title: i.title,
      description: i.description,
      request_format: i.tier === "studio" ? "studio" : i.id,
      styles: i.styles,
      aspects: i.aspects,
      durations_s: Object.keys(i.prices).map(Number),
      prices: Object.entries(i.prices).map(([d, p]) => ({
        duration_s: Number(d),
        atomic: p.toString(),
        usdc: formatUsdc(p),
      })),
      price_usdc: Object.fromEntries(Object.entries(i.prices).map(([d, p]) => [d, formatUsdc(p)])),
      eta_s: i.etaS,
      delivery_default: i.defaultDelivery,
      available: label(i) === null,
      ...(label(i) === null ? {} : { availability: label(i) }),
      what: i.description,
      params: i.params,
    })),
    policy: {
      max_order_usdc: formatUsdc(s.cfg.maxAmount),
      rules: [
        "Typed fields only; no free-text prompts. Omit optional fields rather than inventing names, colours or numbers.",
        "Confirm brand rights and that no real person's likeness is requested (rights_confirmed: true).",
        "No links inside rendered text; a name field may be an ENS/Basename (name.eth) or the brand's own domain alone. logo_url must be https.",
        "Charts and portfolio values come from data, never from the model.",
        ...POLICY_NOTES,
      ],
    },
  };
}

export function createApp(hooks: AppHooks) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const s = hooks.services(c.env);
    c.set("services", s);
    c.set("background", background(c));
    c.set("client", await clientKey(c.req.raw));
    if (s.edgeLimiter && c.req.path.startsWith("/v1/")) {
      const { success } = await s.edgeLimiter.limit({ key: c.var.client }).catch(() => ({ success: true }));
      if (!success)
        return error(
          429,
          { error: "rate_limited", detail: "too many requests", processed: false },
          { "Retry-After": "10" },
        );
    }
    await next();
  });

  app.get("/health", async (c) => {
    const s = c.var.services;
    const [sanctions, render, queue] = await Promise.all([
      s.sanctions.status(),
      renderLiveness(s),
      s.repo.queueDepth(),
    ]);
    return json(200, {
      ok: s.cfg.problems.length === 0 && sanctions.fresh,
      version: VERSION,
      ...publicConfig(s.cfg),
      storage: s.storage.kind,
      chain: s.chain !== null,
      sanctions,
      // last-seen is recorded at most every touchIntervalS (≤30 s), so a polling worker reads 0–30 s here
      render: {
        last_worker_seen_s: render.lastSeenAgoS,
        queue,
        online: render.online,
        stale_after_s: s.cfg.workerStaleS,
      },
    });
  });

  app.get("/llms.txt", (c) =>
    c.body(llmsTxt(c.var.services.cfg), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  );
  app.get("/openapi.json", (c) => json(200, openApi(c.var.services.cfg), { "Cache-Control": "public, max-age=300" }));

  app.get("/v1/styles", async (c) => {
    const online = (await renderLiveness(c.var.services)).online;
    return json(200, stylesView(c.var.services, c.req.query("tier"), c.req.query("format"), online));
  });
  app.get("/v1/stats", async (c) =>
    json(200, { v: 1, ...(await c.var.services.repo.stats()), as_of: nowS(c.var.services) }),
  );

  app.post("/v1/quotes", async (c) => {
    const limited = await throttle(c.var.services, c.var.client, RATE_RULES.quotes);
    if (limited) return limited;
    const body = await readJson(c.req.raw);
    if (!body.ok) return body.response;
    return createQuote(c.var.services, body.value, c.var.client);
  });
  app.get("/v1/quotes/:id", (c) => {
    const id = c.req.param("id");
    return QUOTE_ID.test(id) ? getQuote(c.var.services, id) : error(404, { error: "unknown_quote" });
  });

  // Direct rail nudge (best effort, additive): look for a USDC.transfer to the quote's escrow right now.
  app.post("/v1/quotes/:id/rail", async (c) => {
    const id = c.req.param("id");
    const s = c.var.services;
    const q = QUOTE_ID.test(id) ? await s.repo.getQuote(id) : null;
    if (!q) return error(404, { error: "unknown_quote" });
    const limited = await throttle(s, c.var.client, RATE_RULES.rail);
    if (limited) return limited;
    const outcome = await checkDirect(s, q, 8_000);
    const fresh = (await s.repo.getQuote(id)) ?? q;
    return json(200, { quote_id: id, rail: "direct", outcome, status: fresh.status, order_id: fresh.order_id });
  });

  app.get("/v1/orders", (c) => listOrders(c.var.services, c.req.query("buyer")));
  app.all("/v1/orders/:id", async (c) => {
    const id = c.req.param("id");
    if (QUOTE_ID.test(id)) {
      if (hasPayment(c.req.raw)) {
        const limited = await throttle(c.var.services, c.var.client, RATE_RULES.pay);
        if (limited) return limited;
      }
      return orderResource(c.var.services, c.req.raw, id, c.var.background);
    }
    if (ORDER_ID.test(id)) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD")
        return error(405, { error: "method_not_allowed" }, { Allow: "GET" });
      // access_token as ?token= or, preferably (kept out of URLs and logs), Authorization: Bearer <token>
      return getOrder(c.var.services, id, c.req.query("token") ?? bearerOf(c.req.raw));
    }
    return error(404, { error: "unknown_order" });
  });

  app.post("/v1/auth/siwe/challenge", async (c) => {
    const limited = await throttle(c.var.services, c.var.client, RATE_RULES.siwe);
    if (limited) return limited;
    const body = await readJson(c.req.raw);
    return body.ok ? siweChallenge(c.var.services, body.value) : body.response;
  });
  app.post("/v1/auth/siwe/verify", async (c) => {
    const limited = await throttle(c.var.services, c.var.client, RATE_RULES.siwe);
    if (limited) return limited;
    const body = await readJson(c.req.raw);
    return body.ok ? siweVerify(c.var.services, body.value) : body.response;
  });
  app.post("/v1/reviews/:id/challenge", async (c) => {
    const id = c.req.param("id");
    if (!ORDER_ID.test(id)) return error(404, { error: "unknown_order" });
    const limited = await throttle(c.var.services, c.var.client, RATE_RULES.reviews);
    if (limited) return limited;
    const body = await readJson(c.req.raw);
    return body.ok ? reviewChallenge(c.var.services, id, withToken(body.value, c.req.raw)) : body.response;
  });
  app.post("/v1/reviews/:id/submit", async (c) => {
    const id = c.req.param("id");
    if (!ORDER_ID.test(id)) return error(404, { error: "unknown_order" });
    const limited = await throttle(c.var.services, c.var.client, RATE_RULES.reviews);
    if (limited) return limited;
    const body = await readJson(c.req.raw);
    return body.ok
      ? reviewSubmit(c.var.services, id, withToken(body.value, c.req.raw), c.var.background)
      : body.response;
  });

  // Public artifact storage (used when FILES_BASE_URL points here, e.g. KV-backed deployments).
  app.get("/files/*", async (c) => {
    const key = c.req.path.slice("/files/".length);
    if (!isPublicKey(key)) return error(404, { error: "not_found" });
    const obj = await c.var.services.storage.get(key);
    if (!obj) return error(404, { error: "not_found" });
    return new Response(obj.bytes, {
      status: 200,
      headers: {
        "Content-Type": obj.contentType,
        "Cache-Control": IMMUTABLE_CACHE,
        "Content-Length": String(obj.bytes.byteLength),
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // ------------------------------------------------------------------ internal (render worker, Studio CLI)

  const internal = new Hono<AppEnv>();
  internal.use("*", async (c, next) => {
    const token = c.var.services.cfg.secrets.workerToken;
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !presented || !(await safeEqual(presented, token))) return error(401, { error: "unauthorized" });
    await next();
  });

  internal.post("/jobs/claim", async (c) => {
    const body = await readJson(c.req.raw);
    if (!body.ok) return body.response;
    const b = ClaimBody.safeParse(body.value);
    if (!b.success) return error(400, { error: "invalid_request" });
    return claim(c.var.services, b.data.worker_id, b.data.kinds ?? ["instant_render"]);
  });

  const withJob = async (
    c: { req: { param(n: string): string; header(n: string): string | undefined }; var: Vars },
    fn: (held: Exclude<Awaited<ReturnType<typeof heldJob>>, Response>) => Promise<Response>,
  ): Promise<Response> => {
    const id = c.req.param("id");
    if (!JOB_ID.test(id)) return error(404, { error: "unknown_job" });
    const held = await heldJob(c.var.services, id, c.req.header("x-worker-id"));
    return held instanceof Response ? held : fn(held);
  };

  internal.get("/jobs/:id", (c) =>
    withJob(c, async ({ job, quote }) => json(200, await jobInputs(c.var.services, job, quote))),
  );
  internal.post("/jobs/:id/heartbeat", (c) =>
    withJob(c, async ({ job }) => {
      const body = await readJson(c.req.raw);
      const progress = body.ok
        ? z
            .int()
            .min(0)
            .max(100)
            .safeParse((body.value as { progress?: unknown })?.progress)
        : null;
      return heartbeat(c.var.services, job, progress?.success ? progress.data : null);
    }),
  );
  internal.put("/jobs/:id/still", (c) =>
    withJob(c, async ({ job, quote }) => {
      const bytes = await bytesOf(c.req.raw, 2 * 1024 * 1024);
      return bytes instanceof Response
        ? bytes
        : putStill(c.var.services, job, quote, bytes, c.req.header("content-type") ?? "");
    }),
  );
  internal.put("/jobs/:id/preview", (c) =>
    withJob(c, async ({ job, quote }) => {
      const bytes = await bytesOf(c.req.raw, 16 * 1024 * 1024);
      return bytes instanceof Response
        ? bytes
        : putPreview(c.var.services, job, quote, bytes, c.req.header("content-type") ?? "");
    }),
  );
  internal.put("/jobs/:id/manifest", (c) =>
    withJob(c, async ({ job, quote }) => {
      const body = await readJson(c.req.raw, 256 * 1024);
      return body.ok ? putManifest(c.var.services, job, quote, body.value) : body.response;
    }),
  );
  internal.put("/jobs/:id/chunks/:i", (c) =>
    withJob(c, async ({ job, quote }) => {
      const i = c.req.param("i");
      if (!/^\d{1,5}$/.test(i)) return error(400, { error: "chunk_index" });
      const bytes = await bytesOf(c.req.raw, 1_048_576);
      return bytes instanceof Response ? bytes : putChunk(c.var.services, job, quote, Number(i), bytes);
    }),
  );
  internal.post("/jobs/:id/done", (c) =>
    withJob(c, async ({ job, quote }) => {
      const body = await readJson(c.req.raw);
      if (!body.ok) return body.response;
      const b = DoneBody.safeParse(body.value);
      return b.success ? done(c.var.services, job, quote, b.data) : error(400, { error: "invalid_request" });
    }),
  );
  internal.post("/jobs/:id/failed", (c) =>
    withJob(c, async ({ job, quote }) => {
      const body = await readJson(c.req.raw);
      if (!body.ok) return body.response;
      const b = FailedBody.safeParse(body.value);
      return b.success ? failed(c.var.services, job, quote, b.data) : error(400, { error: "invalid_request" });
    }),
  );

  internal.get("/studio/orders", async (c) => {
    const rows = await c.var.services.repo.studioOrders(50);
    return json(200, {
      orders: rows.map((o) => ({
        order_id: o.id,
        quote_id: o.quote_id,
        status: o.status,
        deadline: o.deadline,
        created_at: o.created_at,
        ...(o.change_requested_at
          ? { change_requested_at: o.change_requested_at, revision_delivered_at: o.revision_delivered_at ?? null }
          : {}),
      })),
    });
  });
  internal.post("/studio/orders/:id/delivery", async (c) => {
    const id = c.req.param("id");
    const worker = c.req.header("x-worker-id");
    if (!ORDER_ID.test(id) || !worker) return error(400, { error: "order_id_and_x_worker_id_required" });
    const o = await c.var.services.repo.getOrder(id);
    return o ? openStudioDelivery(c.var.services, o, worker) : error(404, { error: "unknown_order" });
  });
  internal.post("/studio/orders/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const o = ORDER_ID.test(id) ? await c.var.services.repo.getOrder(id) : null;
    return o ? cancelStudioOrder(c.var.services, o) : error(404, { error: "unknown_order" });
  });
  internal.post("/sanctions/refresh", async (c) => json(200, await c.var.services.sanctions.refresh()));
  internal.post("/keeper/run", async (c) => json(200, await keeperTick(c.var.services)));

  app.route("/internal", internal);

  app.notFound(() => error(404, { error: "not_found" }));
  app.onError((err, c) => {
    c.var.services?.log.error("unhandled", { name: err.name, message: errorText(err, 200), path: c.req.path });
    return error(500, { error: "internal_error" });
  });
  return app;
}
