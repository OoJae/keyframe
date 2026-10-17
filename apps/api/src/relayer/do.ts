import { DurableObject } from "cloudflare:workers";
import { CHAIN_ID } from "@keyframe/protocol";
import {
  type Address,
  createPublicClient,
  formatTransactionReceipt,
  type Hex,
  http,
  type RpcTransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "../config.js";
import { Repo } from "../db/repo.js";
import { consoleLogger } from "../services.js";
import type { WorkerEnv } from "../worker-env.js";
import { type ConsistentRead, RelayerCore, type RelayerStore, type StoredTx } from "./core.js";
import type { ReceiptResult, RelayerClient, RelayRequest, RelayResult, TxKind } from "./types.js";

// Singleton Durable Object holding the relayer key's nonce sequence (idFromName("relayer/v1")). It is the only
// component that signs transactions, and it only ever calls FACTORY_ADDRESS.

const KINDS = new Set<TxKind>([
  "fund",
  "register",
  "release",
  "deliver",
  "decide",
  "cancel",
  "refund",
  "refund_expired",
  "sweep",
]);
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_WAIT_MS = 10_000;

/**
 * eth_getTransactionCount + eth_getTransactionReceipt in ONE JSON-RPC batch (one HTTP request), so a load balancer
 * answers both from the same node and a lagging replica cannot report "nonce used, receipt missing" for a mined tx.
 */
function batchRead(rpcUrl: string): ConsistentRead {
  return async (address: Address, hash: Hex) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [address, "latest"] },
        { jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [hash] },
      ]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`rpc batch http ${res.status}`);
    const out = (await res.json()) as { id: number; result?: unknown; error?: unknown }[];
    if (!Array.isArray(out)) throw new Error("rpc batch: not an array");
    const nonce = out.find((r) => r.id === 1);
    const receipt = out.find((r) => r.id === 2);
    if (!nonce || typeof nonce.result !== "string" || !receipt || receipt.error)
      throw new Error("rpc batch: bad answer");
    return {
      nonce: Number(BigInt(nonce.result)),
      receipt: receipt.result ? formatTransactionReceipt(receipt.result as RpcTransactionReceipt) : null,
    };
  };
}

export class Relayer extends DurableObject<WorkerEnv> {
  private core: RelayerCore | null | undefined;

  private getCore(): RelayerCore | null {
    if (this.core !== undefined) return this.core;
    const cfg = parseConfig(this.env);
    const key = cfg.secrets.relayerPrivateKey;
    if (!key || !cfg.rpcUrl || cfg.factory === "0x0000000000000000000000000000000000000000") {
      this.core = null;
      return null;
    }
    const storage = this.ctx.storage;
    const store: RelayerStore = {
      getNonce: () => storage.get<number>("nonce"),
      putNonce: (n) => storage.put("nonce", n),
      putTx: (hash, tx) => storage.put(`tx:${hash}`, tx),
      getTx: (hash) => storage.get<StoredTx>(`tx:${hash}`),
      deleteTx: async (hash) => {
        await storage.delete(`tx:${hash}`);
      },
      getCounter: (key) => storage.get<number>(`counter:${key}`),
      putCounter: (key, n) => storage.put(`counter:${key}`, n),
    };
    const repo = new Repo(this.env.DB);
    this.core = new RelayerCore({
      account: privateKeyToAccount(key),
      // No `chain`: the relayer signs with an explicit chainId and needs no chain-specific formatters.
      client: createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 5_000, retryCount: 1 }) }),
      factory: cfg.factory,
      chainId: CHAIN_ID,
      store,
      consistentRead: batchRead(cfg.rpcUrl),
      maxTxPerHour: cfg.relayerTxPerHour,
      lowBalanceWei: cfg.relayerLowBalanceWei,
      log: (level, event, fields) => consoleLogger[level](event, fields),
      journal: (e) =>
        repo.journalTx({
          hash: e.hash,
          kind: e.kind,
          ref: e.ref,
          nonce: e.nonce,
          status: e.status,
          error: e.error ?? null,
          created_at: e.at,
        }),
    });
    return this.core;
  }

  async send(req: RelayRequest): Promise<RelayResult> {
    if (!KINDS.has(req.kind) || !HEX.test(req.data) || typeof req.ref !== "string") {
      return { state: "rejected", reason: "malformed relay request" };
    }
    const core = this.getCore();
    if (!core) return { state: "unavailable", reason: "relayer not configured" };
    return core.send({ ...req, waitMs: Math.max(0, Math.min(MAX_WAIT_MS, req.waitMs | 0)) });
  }

  async receipt(hash: Hex, waitMs: number): Promise<ReceiptResult | { state: "unknown"; hash: Hex }> {
    if (!HASH.test(hash)) return { state: "unknown", hash };
    const core = this.getCore();
    if (!core) return { state: "unknown", hash };
    return core.receipt(hash, Math.max(0, Math.min(MAX_WAIT_MS, waitMs | 0)));
  }
}

/** API-side client: every call goes to the one relayer instance. */
export function durableRelayer(ns: DurableObjectNamespace<Relayer>): RelayerClient {
  const stub = () => ns.get(ns.idFromName("relayer/v1"));
  return {
    send: (req) => stub().send(req) as Promise<RelayResult>,
    receipt: (hash, waitMs) => stub().receipt(hash, waitMs) as Promise<ReceiptResult | { state: "unknown"; hash: Hex }>,
  };
}
