import type { ChainReader } from "./chain.js";
import type { Config } from "./config.js";
import type { Repo } from "./db/repo.js";
import type { EdgeRateLimiter } from "./ratelimit.js";
import type { RelayerClient } from "./relayer/types.js";
import type { Sanctions } from "./sanctions.js";
import type { StorageAdapter } from "./storage.js";
import type { KeyframeFacilitator } from "./x402/facilitator.js";
import type { X402Runtime } from "./x402/server.js";

// Everything a request or the keeper needs, wired once per isolate (src/worker.ts) or per test.

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface Services {
  cfg: Config;
  repo: Repo;
  storage: StorageAdapter;
  /** Null when RPC_URL is not configured (chain-dependent paths answer 503). */
  chain: ChainReader | null;
  relayer: RelayerClient;
  sanctions: Sanctions;
  facilitator: KeyframeFacilitator;
  x402: X402Runtime;
  nowMs: () => number;
  log: Logger;
  /** Cloudflare Rate Limiting binding (optional): a per-client cap on every /v1 request at the edge. */
  edgeLimiter?: EdgeRateLimiter;
}

export const nowS = (s: Pick<Services, "nowMs">): number => Math.floor(s.nowMs() / 1000);

/** JSON lines; callers pass ids/hashes/reasons only (never keys, tokens or signatures). */
export const consoleLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};
