import { describe, expect, it } from "vitest";
import { DEFAULT_LOGS_RPC_URL, parseConfig } from "../src/config.js";
import {
  DEFAULT_LOGS_MAX_RANGE,
  estimateBlockAt,
  FALLBACK_CHUNK_BLOCKS,
  LogsRangeError,
  MAX_FALLBACK_CHUNKS,
  scanLogs,
} from "../src/logs.js";
import { allWithin, covers } from "./support/fake-rpc.js";

// The one eth_getLogs path (src/logs.ts): the logs RPC in LOGS_MAX_RANGE windows, RPC_URL for the head and, after a
// logs-RPC failure, in chunks of at most 10 blocks inclusive (Alchemy free tier) under a cap and a time budget.

/** A fake eth_getLogs source: one "log" per listed block, every call recorded; `refuse` decides which ranges fail. */
function source(blocks: bigint[], refuse: (from: bigint, to: bigint) => boolean = () => false) {
  const calls: [bigint, bigint][] = [];
  const fetch = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    if (refuse(from, to))
      throw new Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range");
    return blocks.filter((b) => b >= from && b <= to);
  };
  return { calls, fetch };
}

const far = () => Date.now() + 60_000;
const alchemyFree = (from: bigint, to: bigint) => to - from > 9n;

describe("estimateBlockAt (2 s Base blocks, 30 blocks of margin)", () => {
  it("is latest - ceil((now - at) / 2) - 30", () => {
    expect(estimateBlockAt(10_000n, 1_000, 940)).toBe(10_000n - 30n - 30n);
    expect(estimateBlockAt(10_000n, 1_000, 939)).toBe(10_000n - 31n - 30n); // 61 s → 31 blocks (ceil)
    expect(estimateBlockAt(10_000n, 1_000, 1_000)).toBe(10_000n - 30n);
  });
  it("treats a future time as now and never goes below block 0", () => {
    expect(estimateBlockAt(10_000n, 1_000, 2_000)).toBe(10_000n - 30n);
    expect(estimateBlockAt(50n, 1_000_000, 1)).toBe(0n);
    expect(estimateBlockAt(0n, 10, 10)).toBe(0n);
  });
  it("bounds a direct-rail scan by the quote's age instead of a fixed 2000 blocks", () => {
    // a quote created 10 minutes ago: 300 blocks + 30 of margin
    expect(10_000_000n - estimateBlockAt(10_000_000n, 1_700_000_600, 1_700_000_000)).toBe(330n);
  });
});

describe("scanLogs", () => {
  it("wide range: windows of maxRange on the logs RPC, the newest blocks from RPC_URL, nothing chunked", async () => {
    const logs = source([10n, 2_500n, 4_985n]);
    const main = source([4_995n], alchemyFree);
    const out = await scanLogs(0n, 4_999n, logs.fetch, main.fetch, {
      maxRange: 2_000,
      deadlineMs: far(),
      headBlocks: FALLBACK_CHUNK_BLOCKS,
    });
    expect(out).toEqual([10n, 2_500n, 4_985n, 4_995n]);
    expect(logs.calls).toEqual([
      [0n, 1_999n],
      [2_000n, 3_999n],
      [4_000n, 4_989n],
    ]);
    expect(main.calls).toEqual([[4_990n, 4_999n]]); // one chunk of exactly 10 blocks
  });

  it("one RPC for both (no LOGS_RPC_URL): windows of maxRange, no head split", async () => {
    const rpc = source([5n]);
    const out = await scanLogs(0n, 99n, rpc.fetch, rpc.fetch, { maxRange: DEFAULT_LOGS_MAX_RANGE, deadlineMs: far() });
    expect(out).toEqual([5n]);
    expect(rpc.calls).toEqual([[0n, 99n]]);
  });

  it("logs RPC refuses the range: the rest is read from RPC_URL in chunks of at most 10 blocks inclusive", async () => {
    const blocks = [1_000n, 1_009n, 1_010n, 1_123n, 1_330n];
    const logs = source(blocks, alchemyFree);
    const main = source(blocks, alchemyFree);
    const out = await scanLogs(1_000n, 1_330n, logs.fetch, main.fetch, {
      maxRange: 2_000,
      deadlineMs: far(),
      headBlocks: FALLBACK_CHUNK_BLOCKS,
    });
    expect(out).toEqual(blocks);
    expect(logs.calls).toEqual([[1_000n, 1_320n]]);
    expect(main.calls.length).toBe(34); // 331 blocks
    expect(allWithin(main.calls, 10)).toBe(true);
    expect(covers(main.calls, 1_000n, 1_330n)).toBe(true);
  });

  it("a logs-RPC failure after some windows only moves the remainder to the fallback", async () => {
    const logs = source([5n], (from) => from >= 2_000n);
    const main = source([2_040n], alchemyFree);
    const out = await scanLogs(0n, 2_049n, logs.fetch, main.fetch, { maxRange: 2_000, deadlineMs: far() });
    expect(out).toEqual([5n, 2_040n]);
    expect(logs.calls).toEqual([
      [0n, 1_999n],
      [2_000n, 2_049n],
    ]);
    expect(covers(main.calls, 2_000n, 2_049n)).toBe(true);
    expect(allWithin(main.calls, 10)).toBe(true);
  });

  it("cap exceeded: a clear LogsRangeError before any fallback request (never a partial list)", async () => {
    const logs = source([], () => true);
    const main = source([]);
    const blocks = BigInt(MAX_FALLBACK_CHUNKS * FALLBACK_CHUNK_BLOCKS);
    const err = await scanLogs(0n, blocks, logs.fetch, main.fetch, { maxRange: 2_000, deadlineMs: far() }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LogsRangeError);
    expect(String(err.message)).toMatch(/need 121 eth_getLogs requests of 10 blocks on RPC_URL \(cap 120\)/);
    expect(String(err.message)).toMatch(/after the logs RPC failed/);
    expect(main.calls).toEqual([]);
    // exactly at the cap it works
    const ok = await scanLogs(0n, blocks - 1n, logs.fetch, main.fetch, { maxRange: 2_000, deadlineMs: far() });
    expect(ok).toEqual([]);
    expect(main.calls.length).toBe(MAX_FALLBACK_CHUNKS);
  });

  it("event lookups (first) stop at the first hit; the cap still ends a fruitless scan", async () => {
    const logs = source([], () => true);
    const main = source([1_035n, 1_500n]);
    const hit = await scanLogs(1_000n, 9_000n, logs.fetch, main.fetch, {
      maxRange: 2_000,
      deadlineMs: far(),
      first: true,
    });
    expect(hit).toEqual([1_035n]);
    expect(main.calls.length).toBe(4);
    const none = source([]);
    const err = await scanLogs(1_000n, 9_000n, logs.fetch, none.fetch, {
      maxRange: 2_000,
      deadlineMs: far(),
      first: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LogsRangeError);
    expect(none.calls.length).toBe(MAX_FALLBACK_CHUNKS);
  });

  it("the caller's time budget ends the scan with a LogsRangeError", async () => {
    let t = 0;
    const logs = source([], () => true);
    const main = {
      calls: 0,
      fetch: async () => {
        main.calls++;
        t += 1_000;
        return [];
      },
    };
    const err = await scanLogs(0n, 299n, logs.fetch, main.fetch, {
      maxRange: 2_000,
      deadlineMs: 5_000,
      now: () => t,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LogsRangeError);
    expect(String(err.message)).toMatch(/time budget exhausted/);
    expect(main.calls).toBe(6);
  });

  it("a failing fallback request is a LogsRangeError, not a partial result", async () => {
    const logs = source([], () => true);
    const main = source([], (from) => from === 20n);
    const err = await scanLogs(0n, 99n, logs.fetch, main.fetch, { maxRange: 2_000, deadlineMs: far() }).catch((e) => e);
    expect(err).toBeInstanceOf(LogsRangeError);
    expect(String(err.message)).toMatch(/eth_getLogs 20\.\.29 failed on RPC_URL/);
  });

  it("an empty range makes no request", async () => {
    const rpc = source([]);
    expect(await scanLogs(5n, 4n, rpc.fetch, rpc.fetch, { maxRange: 10, deadlineMs: far() })).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });
});

describe("LOGS_RPC_URL / LOGS_MAX_RANGE config", () => {
  it("defaults to the public logs RPC and 2000-block windows", () => {
    const c = parseConfig({ RPC_URL: "https://base-mainnet.example/v2/key" });
    expect(c.logsRpcUrl).toBe(DEFAULT_LOGS_RPC_URL);
    expect(DEFAULT_LOGS_RPC_URL).toBe("https://base-rpc.publicnode.com");
    expect(c.logsMaxRange).toBe(2_000);
  });
  it("a local RPC_URL (anvil, a fork) serves its own logs unless LOGS_RPC_URL says otherwise", () => {
    expect(parseConfig({ RPC_URL: "http://127.0.0.1:8545" }).logsRpcUrl).toBeNull();
    expect(parseConfig({ RPC_URL: "http://localhost:8545" }).logsRpcUrl).toBeNull();
    expect(parseConfig({ RPC_URL: "http://127.0.0.1:8545", LOGS_RPC_URL: "http://127.0.0.1:9545" }).logsRpcUrl).toBe(
      "http://127.0.0.1:9545",
    );
  });
  it('"" or an invalid value means RPC_URL serves eth_getLogs; LOGS_MAX_RANGE is bounded', () => {
    expect(parseConfig({ RPC_URL: "https://x.example", LOGS_RPC_URL: "" }).logsRpcUrl).toBeNull();
    expect(
      parseConfig({ RPC_URL: "https://x.example", LOGS_RPC_URL: "base-rpc.publicnode.com" }).logsRpcUrl,
    ).toBeNull();
    expect(parseConfig({ LOGS_RPC_URL: " https://logs.example " }).logsRpcUrl).toBe("https://logs.example");
    expect(parseConfig({ LOGS_MAX_RANGE: "9000" }).logsMaxRange).toBe(9_000);
    expect(parseConfig({ LOGS_MAX_RANGE: "0" }).logsMaxRange).toBe(2_000);
    expect(parseConfig({ LOGS_MAX_RANGE: "1000000" }).logsMaxRange).toBe(2_000);
  });
});
