import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { keyframeFactoryAbi } from "@keyframe/protocol";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { viemChainReader } from "../src/chain.js";
import { LogsRangeError } from "../src/logs.js";
import { allWithin, covers, type FakeRpc, startFakeRpc, transferLog } from "./support/fake-rpc.js";

// workerd cancels a request whose only pending I/O belongs to another request. viem's batch scheduler is shared per
// URL across the isolate, so the chain reader must never batch: every read of a request has to be that request's
// own fetch. (Found on the Base-fork e2e: two concurrent payments for one quote → one 500 "code had hung".)

describe("viemChainReader transport", () => {
  const bodies: string[] = [];
  let url = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    bodies.push(body);
    const one = (m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, result: `0x${"0".repeat(63)}1` });
    const parsed = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends concurrent reads (even from two readers on one URL) as separate, unbatched requests", async () => {
    const a = viemChainReader(url);
    const b = viemChainReader(url);
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const who = "0x1111111111111111111111111111111111111111";
    const out = await Promise.all([a.balanceOf(usdc, who), b.balanceOf(usdc, who), a.balanceOf(usdc, usdc)]);
    expect(out).toEqual([1n, 1n, 1n]);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(Array.isArray(JSON.parse(body))).toBe(false);
  });
});

// eth_getLogs through the real reader: LOGS_RPC_URL (wide windows) + RPC_URL (Alchemy free tier: ≤ 10 blocks).
describe("viemChainReader eth_getLogs", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const E = "0x00000000000000000000000000000000000e5c70" as const;
  const BUYER = "0x1111111111111111111111111111111111111111" as const;
  const OTHER = "0x3333333333333333333333333333333333333333" as const;
  const HEAD = 30_000_000n;
  const rpcs: FakeRpc[] = [];
  const start = async (o: Parameters<typeof startFakeRpc>[0]) => {
    const r = await startFakeRpc(o);
    rpcs.push(r);
    return r;
  };
  afterAll(async () => {
    await Promise.all(rpcs.map((r) => r.close()));
  });
  const logs = [transferLog(USDC, OTHER, E, 7n, HEAD - 300n), transferLog(USDC, BUYER, E, 1_000_000n, HEAD - 2n)];
  const nowS = 1_800_000_000;
  // created 10 minutes ago: from = HEAD - 300 - 30
  const since = { sinceS: nowS - 600, nowS };

  it("reads a wide range from the logs RPC in one window and only the newest 10 blocks from RPC_URL", async () => {
    const main = await start({ head: HEAD, logs, maxRange: 10 });
    // a load-balanced public node 2 blocks behind: a toBlock past its head would be refused
    const pub = await start({ head: HEAD, logsHead: HEAD - 2n, logs, maxRange: 9_000 });
    const r = viemChainReader(main.url, { logsRpcUrl: pub.url, logsMaxRange: 2_000 });
    const out = await r.transfersTo(USDC, E, since);
    expect(out.map((t) => [t.from, t.value])).toEqual([
      [OTHER, 7n],
      [BUYER, 1_000_000n],
    ]);
    expect(pub.ranges).toEqual([[HEAD - 330n, HEAD - 10n]]);
    expect(main.ranges).toEqual([[HEAD - 9n, HEAD]]);
  });

  it("logs RPC refusing wide ranges: the whole range comes from RPC_URL in ≤ 10-block chunks", async () => {
    const main = await start({ head: HEAD, logs, maxRange: 10 });
    const pub = await start({ head: HEAD, logs, maxRange: 10 });
    const r = viemChainReader(main.url, { logsRpcUrl: pub.url });
    const out = await r.transfersTo(USDC, E, since);
    expect(out.map((t) => t.value)).toEqual([7n, 1_000_000n]);
    expect(pub.ranges).toEqual([[HEAD - 330n, HEAD - 10n]]);
    expect(main.ranges.length).toBe(34);
    expect(allWithin(main.ranges, 10)).toBe(true);
    expect(covers(main.ranges, HEAD - 330n, HEAD)).toBe(true);
  });

  it("logs RPC down: same chunked fallback; no LOGS_RPC_URL: RPC_URL alone, chunked when it refuses", async () => {
    const main = await start({ head: HEAD, logs, maxRange: 10 });
    const down = await start({ head: HEAD, down: true });
    expect((await viemChainReader(main.url, { logsRpcUrl: down.url }).transfersTo(USDC, E, since)).length).toBe(2);
    expect(allWithin(main.ranges, 10)).toBe(true);
    const solo = await start({ head: HEAD, logs, maxRange: 10 });
    expect((await viemChainReader(solo.url).transfersTo(USDC, E, since)).length).toBe(2);
    expect(solo.ranges[0]).toEqual([HEAD - 330n, HEAD]); // one wide try first
    expect(allWithin(solo.ranges.slice(1), 10)).toBe(true);
    expect(covers(solo.ranges.slice(1), HEAD - 330n, HEAD)).toBe(true);
  });

  it("a range the fallback cannot cover is a clear error before any chunk is sent", async () => {
    const main = await start({ head: HEAD, logs, maxRange: 10 });
    const pub = await start({ head: HEAD, logs, maxRange: 10 });
    const r = viemChainReader(main.url, { logsRpcUrl: pub.url });
    // an hour-old quote: 1830 blocks → 183 chunks > 120
    const err = await r.transfersTo(USDC, E, { sinceS: nowS - 3_600, nowS }).catch((e) => e);
    expect(err).toBeInstanceOf(LogsRangeError);
    expect(String(err.message)).toMatch(/cap 120/);
    expect(String(err.message)).not.toContain(pub.url); // provider errors are redacted to the host
    expect(main.ranges).toEqual([]);
  });

  it("eventTx: from the block of the event's own timestamp (chain clock), stopping at the first hit", async () => {
    const FACTORY = "0x00000000000000000000000000000000000f4c70" as const;
    const termsHash = `0x${"ab".repeat(32)}` as const;
    const topics = encodeEventTopics({ abi: keyframeFactoryAbi, eventName: "Refunded", args: { termsHash } }) as Hex[];
    const ev = {
      address: FACTORY,
      topics,
      data: encodeAbiParameters([{ type: "uint256" }], [5n]),
      blockNumber: HEAD - 3_000n,
      tx: `0x${"ee".repeat(32)}` as Hex,
    };
    const headTimestamp = 1_800_000_000;
    const main = await start({ head: HEAD, headTimestamp, logs: [ev], maxRange: 10 });
    const pub = await start({ head: HEAD, headTimestamp, logs: [ev], maxRange: 9_000 });
    const r = viemChainReader(main.url, { logsRpcUrl: pub.url, logsMaxRange: 2_000 });
    const finalAt = headTimestamp - 6_000; // 3000 blocks ago
    expect(await r.eventTx(FACTORY, "Refunded", termsHash, { sinceS: finalAt })).toBe(ev.tx);
    expect(pub.ranges).toEqual([[HEAD - 3_030n, HEAD - 1_031n]]); // one window, found, done
    expect(main.ranges).toEqual([]);
    // the old fixed 9000-block lookback through an Alchemy-free-tier RPC_URL alone would need 900 chunks; with the
    // time bound the event is in the 4th chunk
    const solo = await start({ head: HEAD, headTimestamp, logs: [ev], maxRange: 10 });
    expect(await viemChainReader(solo.url).eventTx(FACTORY, "Refunded", termsHash, { sinceS: finalAt })).toBe(ev.tx);
    expect(solo.ranges.length).toBe(5);
    expect(allWithin(solo.ranges.slice(1), 10)).toBe(true);
  });
});
