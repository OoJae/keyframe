import { sha256Hex } from "@keyframe/protocol";
import { error } from "./http.js";
import { errorText } from "./redact.js";
import type { Services } from "./services.js";

// Per-client throttling (ADR-019). Clients are keyed by CF-Connecting-IP (set by Cloudflare's edge on every request
// and not spoofable through it), hashed so raw IPs are never stored. Costly or chain-touching public endpoints take
// a token from a D1 token bucket; a Cloudflare Rate Limiting binding (RATE_LIMITER, wrangler.toml), when bound,
// additionally caps every /v1 request per client at the edge. Requests without the header (local tools, tests) share
// one "local" bucket.

export interface RateRule {
  name: string;
  /** Burst size. */
  capacity: number;
  /** Sustained rate, tokens per second. */
  refillPerS: number;
}

export const RATE_RULES = {
  /** Quote creation: renders and D1 writes. 30 burst, then 1 per 20 s. */
  quotes: { name: "quotes", capacity: 30, refillPerS: 1 / 20 },
  /** Direct-rail nudge: chain reads and possibly a relayer transaction. 10 burst, then 1 per 6 s. */
  rail: { name: "rail", capacity: 10, refillPerS: 1 / 6 },
  /** Paid requests (x402 verify simulates on the RPC). 60 burst, then 1 per s. */
  pay: { name: "pay", capacity: 60, refillPerS: 1 },
  /** SIWE challenge/verify. 20 burst, then 1 per 3 s. */
  siwe: { name: "siwe", capacity: 20, refillPerS: 1 / 3 },
  /** Studio review challenge/submit. 30 burst, then 1 per 2 s. */
  reviews: { name: "reviews", capacity: 30, refillPerS: 1 / 2 },
} as const satisfies Record<string, RateRule>;

/** Structural view of the Workers Rate Limiting binding. */
export interface EdgeRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Hashed client bucket from CF-Connecting-IP ("local" when absent). */
export async function clientKey(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip")?.trim();
  if (!ip) return "local";
  return `ip:${(await sha256Hex(`kf/client/v1/${ip.toLowerCase()}`)).slice(2, 26)}`;
}

/** Takes one token for `rule`; a 429 response when the bucket is empty, null to proceed. Fails open on D1 errors. */
export async function throttle(s: Services, client: string, rule: RateRule): Promise<Response | null> {
  if (!s.cfg.rateLimits) return null;
  try {
    if (await s.repo.takeToken(`${rule.name}:${client}`, rule.capacity, rule.refillPerS, s.nowMs())) return null;
  } catch (e) {
    s.log.warn("rate_limit_unavailable", { rule: rule.name, error: errorText(e, 120) });
    return null;
  }
  const retry = Math.max(1, Math.ceil(1 / rule.refillPerS));
  // No "charged" claim: a throttled paid retry may belong to an authorization an earlier request is settling.
  return error(
    429,
    {
      error: "rate_limited",
      detail: `too many ${rule.name} requests from this client; this request was not processed, retry it unchanged after Retry-After`,
      processed: false,
    },
    { "Retry-After": String(retry) },
  );
}
