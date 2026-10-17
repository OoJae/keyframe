import { errorText } from "./redact.js";

// eth_getLogs over block ranges that providers accept. Free RPC plans cap the range (Alchemy free tier: at most 10
// blocks inclusive, i.e. toBlock - fromBlock <= 9, and fromBlock = latest-10 is already refused), so a scan reads
// the range from a dedicated logs RPC (LOGS_RPC_URL, which serves wide ranges) in windows of LOGS_MAX_RANGE blocks,
// and falls back to RPC_URL in 10-block chunks when that fails, under a chunk cap and the caller's time budget.
// The newest blocks always come from RPC_URL (the client that read `latest`): a load-balanced public node may be a
// few blocks behind it and refuses a toBlock beyond its own head ("block range extends beyond current head block").

/** Base produces a block every 2 s. */
export const BASE_BLOCK_S = 2;
/** Blocks of slack before an estimated start block (clock skew between the API and the chain, jitter). */
export const LOOKBACK_MARGIN_BLOCKS = 30;
/** Fallback chunk on RPC_URL: 10 blocks inclusive (Alchemy free tier). */
export const FALLBACK_CHUNK_BLOCKS = 10;
/** At most this many fallback requests per scan (1 200 blocks, 40 min of Base). */
export const MAX_FALLBACK_CHUNKS = 120;
/** Default blocks per request on the logs RPC (LOGS_MAX_RANGE). */
export const DEFAULT_LOGS_MAX_RANGE = 2_000;
/** Time budget of a scan whose caller gives none. */
export const DEFAULT_LOGS_BUDGET_MS = 10_000;

/** A scan that cannot cover its range: logs RPC failed and the fallback is over its cap, budget or failed too. */
export class LogsRangeError extends Error {
  override name = "LogsRangeError";
}

/** One eth_getLogs call over [fromBlock, toBlock] (inclusive). */
export type LogsFetch<T> = (fromBlock: bigint, toBlock: bigint) => Promise<T[]>;

export interface ScanOptions {
  /** Blocks per request on the primary (inclusive count). */
  maxRange: number;
  /** Absolute Date.now() deadline: no request starts after it. */
  deadlineMs: number;
  /** Stop at the first request that returns a log (event lookups); the cap is then checked as the scan goes. */
  first?: boolean;
  /** The newest `headBlocks` blocks are read from the fallback only (0 when primary and fallback are one RPC). */
  headBlocks?: number;
  chunkBlocks?: number;
  maxChunks?: number;
  now?: () => number;
}

/**
 * First block of a scan for logs at or after unix time `atS` when it is `nowS` on the same clock and `latest` is
 * the head: latest - ceil((now - at) / 2) - margin, never below 0 (a future `atS` counts as now).
 */
export function estimateBlockAt(
  latest: bigint,
  nowS: number,
  atS: number,
  marginBlocks: number = LOOKBACK_MARGIN_BLOCKS,
): bigint {
  const elapsed = Math.max(0, nowS - atS);
  const back = BigInt(Math.ceil(elapsed / BASE_BLOCK_S) + marginBlocks);
  return latest > back ? latest - back : 0n;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Logs of [from, to] in block order: `primary` in windows of `maxRange` (except the newest `headBlocks`), and from
 * the first primary failure on, the rest through `fallback` in chunks of `chunkBlocks`. Throws LogsRangeError when
 * the range cannot be covered (the fallback would need more than `maxChunks` requests, the budget ran out, or a
 * fallback request failed): callers never get a partial result.
 */
export async function scanLogs<T>(
  from: bigint,
  to: bigint,
  primary: LogsFetch<T>,
  fallback: LogsFetch<T>,
  o: ScanOptions,
): Promise<T[]> {
  const out: T[] = [];
  if (to < from) return out;
  const window = BigInt(Math.max(1, Math.floor(o.maxRange)));
  const chunk = BigInt(Math.max(1, o.chunkBlocks ?? FALLBACK_CHUNK_BLOCKS));
  const maxChunks = o.maxChunks ?? MAX_FALLBACK_CHUNKS;
  const now = o.now ?? Date.now;
  let chunks = 0;
  let cause: unknown = null;
  const why = () => (cause === null ? "" : ` after the logs RPC failed (${errorText(cause, 120)})`);
  const inBudget = (at: bigint) => {
    if (now() > o.deadlineMs) {
      throw new LogsRangeError(`eth_getLogs time budget exhausted at block ${at} of ${from}..${to}${why()}`);
    }
  };

  let cursor = from;
  const primaryEnd = to - BigInt(Math.max(0, o.headBlocks ?? 0));
  while (cursor <= primaryEnd) {
    inBudget(cursor);
    const end = min(primaryEnd, cursor + window - 1n);
    let got: T[];
    try {
      got = await primary(cursor, end);
    } catch (e) {
      cause = e; // range refused, rate limited or down: the rest goes to the fallback
      break;
    }
    out.push(...got);
    if (o.first && got.length > 0) return out;
    cursor = end + 1n;
  }
  if (cursor > to) return out;

  const need = (to - cursor) / chunk + 1n;
  if (!o.first && need > BigInt(maxChunks)) {
    throw new LogsRangeError(
      `blocks ${cursor}..${to} need ${need} eth_getLogs requests of ${chunk} blocks on RPC_URL (cap ${maxChunks})${why()}`,
    );
  }
  for (let c = cursor; c <= to; c += chunk) {
    inBudget(c);
    if (++chunks > maxChunks) {
      throw new LogsRangeError(
        `eth_getLogs fallback cap (${maxChunks} requests) reached at block ${c} of ${from}..${to}${why()}`,
      );
    }
    const end = min(to, c + chunk - 1n);
    let got: T[];
    try {
      got = await fallback(c, end);
    } catch (e) {
      throw new LogsRangeError(`eth_getLogs ${c}..${end} failed on RPC_URL (${errorText(e, 120)})${why()}`);
    }
    out.push(...got);
    if (o.first && got.length > 0) return out;
  }
  return out;
}
