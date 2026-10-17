import { HTTPFacilitatorClient } from "@x402/core/server";
import { createApp } from "./app.js";
import { viemChainReader } from "./chain.js";
import { parseConfig } from "./config.js";
import { Repo } from "./db/repo.js";
import { keeperTick } from "./keeper.js";
import { durableRelayer } from "./relayer/do.js";
import { Sanctions } from "./sanctions.js";
import { consoleLogger, type Services } from "./services.js";
import { storageFor } from "./storage.js";
import type { WorkerEnv } from "./worker-env.js";
import { KeyframeFacilitator } from "./x402/facilitator.js";
import { X402Runtime } from "./x402/server.js";

// Cloudflare Workers entry: fetch (Hono app), scheduled (keeper, every minute) and the relayer Durable Object.

export { Relayer } from "./relayer/do.js";

const cache = new WeakMap<object, Services>();

function services(env: WorkerEnv): Services {
  const hit = cache.get(env);
  if (hit) return hit;
  const cfg = parseConfig(env);
  const repo = new Repo(env.DB);
  const storage = storageFor({ FILES: env.FILES, KV: env.KV });
  if (!storage) throw new Error("no storage binding (FILES or KV)");
  const chain = cfg.rpcUrl ? viemChainReader(cfg.rpcUrl) : null;
  const relayer = durableRelayer(env.RELAYER);
  const sanctions = new Sanctions(repo, {
    listUrl: cfg.ofacListUrl,
    maxAgeS: cfg.ofacMaxAgeS,
    fetch: (input, init) => fetch(input, init),
    nowMs: () => Date.now(),
  });
  const facilitator = new KeyframeFacilitator({
    signer: () => {
      if (!chain) throw new Error("RPC_URL not configured");
      return chain.x402Signer(cfg.operator ? [cfg.operator] : []);
    },
    relayer,
    fallback: cfg.facilitatorFallbackUrl
      ? new HTTPFacilitatorClient({ url: cfg.facilitatorFallbackUrl, timeoutMs: 8_000 })
      : null,
    receiptWaitMs: cfg.receiptWaitMs,
    chain,
    factory: cfg.factory,
    usdc: cfg.usdc,
  });
  const s: Services = {
    cfg,
    repo,
    storage,
    chain,
    relayer,
    sanctions,
    facilitator,
    x402: new X402Runtime(facilitator, cfg.usdc),
    nowMs: () => Date.now(),
    log: consoleLogger,
    ...(env.RATE_LIMITER ? { edgeLimiter: env.RATE_LIMITER } : {}),
  };
  cache.set(env, s);
  return s;
}

const app = createApp({ services: (env) => services(env as WorkerEnv) });

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(keeperTick(services(env)));
  },
} satisfies ExportedHandler<WorkerEnv>;
