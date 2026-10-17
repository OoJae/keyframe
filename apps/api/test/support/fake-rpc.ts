import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Address, encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex, toHex } from "viem";

// A JSON-RPC endpoint with the eth_getLogs behaviours of real providers: Alchemy's free tier (at most 10 blocks
// inclusive, HTTP 400 / -32600 beyond), a load-balanced public node a few blocks behind the head (-32602 for a
// toBlock past its own head), or an outage (HTTP 503). Every eth_getLogs range is recorded.

export interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  tx: Hex;
}

export interface FakeRpcOptions {
  head: bigint;
  /** Unix seconds of the head block (eth_getBlockByNumber "latest"). */
  headTimestamp?: number;
  logs?: FakeLog[];
  /** Largest eth_getLogs range (toBlock - fromBlock + 1) served; beyond it, the Alchemy free-tier refusal. */
  maxRange?: number;
  /** This node's own head for eth_getLogs (lagging behind `head`): a toBlock past it is refused. */
  logsHead?: bigint;
  /** Every eth_getLogs answers HTTP 503. */
  down?: boolean;
}

export interface FakeRpc {
  url: string;
  opts: FakeRpcOptions;
  /** [fromBlock, toBlock] of every eth_getLogs received (served or refused), in order. */
  ranges: [bigint, bigint][];
  methods: string[];
  close(): Promise<void>;
}

const ALCHEMY_FREE =
  "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Upgrade to PAYG for expanded block range.";

const big = (v: unknown, head: bigint): bigint =>
  v === "latest" || v === undefined ? head : v === "earliest" ? 0n : BigInt(v as string);

function topicMatches(want: unknown, have: Hex | undefined): boolean {
  if (want === null || want === undefined) return true;
  const list = Array.isArray(want) ? want : [want];
  return list.some((w) => typeof w === "string" && have !== undefined && w.toLowerCase() === have.toLowerCase());
}

export async function startFakeRpc(opts: FakeRpcOptions): Promise<FakeRpc> {
  const ranges: [bigint, bigint][] = [];
  const methods: string[] = [];
  const answer = (m: { id: number; method: string; params?: unknown[] }): { status: number; body: unknown } => {
    methods.push(m.method);
    const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: m.id, result } });
    const err = (status: number, code: number, message: string) => ({
      status,
      body: { jsonrpc: "2.0", id: m.id, error: { code, message } },
    });
    switch (m.method) {
      case "eth_chainId":
        return ok("0x2105");
      case "eth_blockNumber":
        return ok(toHex(opts.head));
      case "eth_getBlockByNumber": {
        const n = big(m.params?.[0], opts.head);
        const ts = (opts.headTimestamp ?? Math.floor(Date.now() / 1000)) - Number(opts.head - n) * 2;
        return ok({
          number: toHex(n),
          timestamp: toHex(ts),
          hash: toHex(n, { size: 32 }),
          parentHash: toHex(n - 1n, { size: 32 }),
          transactions: [],
        });
      }
      case "eth_getLogs": {
        const f = (m.params?.[0] ?? {}) as Record<string, unknown>;
        const from = big(f.fromBlock, opts.head);
        const to = big(f.toBlock, opts.head);
        ranges.push([from, to]);
        if (opts.down) return err(503, -32603, "service unavailable");
        if (opts.maxRange !== undefined && to - from + 1n > BigInt(opts.maxRange))
          return err(400, -32600, ALCHEMY_FREE);
        const own = opts.logsHead ?? opts.head;
        if (to > own) {
          return err(200, -32602, `block range extends beyond current head block: requested ${to}, head ${own}`);
        }
        const addresses = (Array.isArray(f.address) ? f.address : [f.address]).filter(Boolean) as string[];
        const topics = (f.topics ?? []) as unknown[];
        const hits = (opts.logs ?? []).filter(
          (l) =>
            l.blockNumber >= from &&
            l.blockNumber <= to &&
            (addresses.length === 0 || addresses.some((a) => a.toLowerCase() === l.address.toLowerCase())) &&
            topics.every((t, i) => topicMatches(t, l.topics[i])),
        );
        return ok(
          hits.map((l, i) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: toHex(l.blockNumber),
            blockHash: toHex(l.blockNumber, { size: 32 }),
            transactionHash: l.tx,
            transactionIndex: "0x0",
            logIndex: toHex(i),
            removed: false,
          })),
        );
      }
      default:
        return err(200, -32601, `method ${m.method} not supported by the fake`);
    }
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (Array.isArray(parsed)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(parsed.map((m) => answer(m).body)));
      return;
    }
    const a = answer(parsed);
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    opts,
    ranges,
    methods,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** An ERC-20 Transfer(from, to, value) log of `token` at `blockNumber`. */
export function transferLog(token: Address, from: Address, to: Address, value: bigint, blockNumber: bigint): FakeLog {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber,
    tx: toHex(blockNumber * 1000n + value, { size: 32 }),
  };
}

/** Every range spans at most `n` blocks inclusive (toBlock - fromBlock <= n - 1). */
export const allWithin = (ranges: [bigint, bigint][], n: number) =>
  ranges.every(([a, b]) => b >= a && b - a <= BigInt(n - 1));

/** The ranges are contiguous and cover exactly [from, to]. */
export function covers(ranges: [bigint, bigint][], from: bigint, to: bigint): boolean {
  let next = from;
  for (const [a, b] of ranges) {
    if (a !== next) return false;
    next = b + 1n;
  }
  return next === to + 1n;
}
