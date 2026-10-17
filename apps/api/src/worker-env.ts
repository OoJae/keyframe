import type { RawEnv } from "./config.js";
import type { EdgeRateLimiter } from "./ratelimit.js";
import type { Relayer } from "./relayer/do.js";

/** Bindings declared in wrangler.toml plus the string vars/secrets parsed by config.ts. */
export interface WorkerEnv extends RawEnv {
  DB: D1Database;
  KV: KVNamespace;
  FILES?: R2Bucket;
  RELAYER: DurableObjectNamespace<Relayer>;
  /** Optional Cloudflare Rate Limiting binding ([[ratelimits]] in wrangler.toml). */
  RATE_LIMITER?: EdgeRateLimiter;
}
