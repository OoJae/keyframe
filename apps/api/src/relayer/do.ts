import { DurableObject } from "cloudflare:workers";
import { CHAIN_ID } from "@keyframe/protocol";
import { createPublicClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "../config.js";
import { Repo } from "../db/repo.js";
import type { WorkerEnv } from "../worker-env.js";
import { RelayerCore, type RelayerStore, type StoredTx } from "./core.js";
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
    };
    const repo = new Repo(this.env.DB);
    this.core = new RelayerCore({
      account: privateKeyToAccount(key),
      // No `chain`: the relayer signs with an explicit chainId and needs no chain-specific formatters.
      client: createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 5_000, retryCount: 1 }) }),
      factory: cfg.factory,
      chainId: CHAIN_ID,
      store,
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
