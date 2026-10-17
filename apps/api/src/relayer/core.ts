import { keyframeFactoryAbi } from "@keyframe/protocol";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  ExecutionRevertedError,
  type Hex,
  InsufficientFundsError,
  keccak256,
  type LocalAccount,
  NonceTooLowError,
  type PublicClient,
  type TransactionReceipt,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import type { ReceiptResult, RelayLog, RelayRequest, RelayResult, TxKind } from "./types.js";

// Relayer logic (runs inside the singleton Durable Object): one hot EOA (= T.operator), serialized nonces,
// simulate-before-send, a raw-tx store so an ambiguous broadcast can be re-sent, and receipt reconciliation.
// The only destination is the factory.

export interface RelayerStore {
  getNonce(): Promise<number | undefined>;
  putNonce(n: number): Promise<void>;
  putTx(hash: Hex, tx: StoredTx): Promise<void>;
  getTx(hash: Hex): Promise<StoredTx | undefined>;
  deleteTx(hash: Hex): Promise<void>;
}

export interface StoredTx {
  raw: Hex;
  nonce: number;
  kind: TxKind;
  ref: string;
  sentAt: number;
}

export interface JournalEntry {
  hash: Hex;
  kind: TxKind;
  ref: string;
  nonce: number;
  status: "sent" | "confirmed" | "reverted" | "dropped";
  error?: string | null;
  at: number;
}

export interface RelayerDeps {
  account: LocalAccount;
  client: PublicClient;
  factory: Address;
  chainId: number;
  store: RelayerStore;
  journal?: (e: JournalEntry) => Promise<void>;
  nowS?: () => number;
}

const GAS_BUFFER_BPS = 12_000n;
// Node answers that mean "not accepted into the pool" (so nothing was broadcast).
const DEFINITE_REJECTION =
  /nonce too (?:low|high)|underpriced|max fee per gas less than|intrinsic gas too low|insufficient funds|exceeds block gas limit|invalid sender/;

function findHexData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 10; depth++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
      const inner = (d as { data: string }).data;
      if (/^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Decoded revert reason ("AlreadyRegistered", "Error: FiatTokenV2: invalid signature"), or null if not a revert. */
export function revertReason(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError);
  if (!reverted) return null;
  const data = findHexData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: keyframeFactoryAbi, data });
      const args = (d.args ?? []).map((a) => String(a)).join(",");
      return (d.errorName as string) === "Error" ? `Error: ${args}` : `${d.errorName}(${args})`;
    } catch {
      // unknown selector: fall through to the message
    }
  }
  return (reverted as BaseError).shortMessage?.slice(0, 200) ?? "execution reverted";
}

const shortError = (err: unknown): string =>
  (err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err)).slice(0, 200);

function toLogs(r: TransactionReceipt): RelayLog[] {
  return r.logs.map((l) => ({ address: l.address, topics: [...l.topics] as Hex[], data: l.data }));
}

export class RelayerCore {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly d: RelayerDeps;

  constructor(deps: RelayerDeps) {
    this.d = deps;
  }

  get address(): Address {
    return this.d.account.address;
  }

  private now(): number {
    return this.d.nowS ? this.d.nowS() : Math.floor(Date.now() / 1000);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async journal(e: JournalEntry): Promise<void> {
    try {
      await this.d.journal?.(e);
    } catch {
      // the journal is advisory; the DO's raw-tx store is the source of truth for reconciliation
    }
  }

  private async nextNonce(): Promise<number> {
    const [stored, chain] = await Promise.all([
      this.d.store.getNonce(),
      this.d.client.getTransactionCount({ address: this.address, blockTag: "pending" }),
    ]);
    return Math.max(stored ?? 0, chain);
  }

  /** Simulate, sign and broadcast under the nonce lock; then (outside the lock) wait for the receipt. */
  async send(req: RelayRequest): Promise<RelayResult> {
    const broadcast = await this.serialized(() => this.broadcast(req));
    if (broadcast.state !== "sent") return broadcast;
    if (req.waitMs <= 0) return { state: "pending", hash: broadcast.hash };
    return this.awaitReceipt(broadcast.hash, req.waitMs);
  }

  private async broadcast(
    req: RelayRequest,
  ): Promise<{ state: "sent"; hash: Hex } | Extract<RelayResult, { state: "rejected" | "unavailable" }>> {
    const { client, account, factory } = this.d;
    let gas: bigint;
    try {
      gas = await client.estimateGas({ account: account.address, to: factory, data: req.data });
    } catch (err) {
      const reason = revertReason(err);
      return reason ? { state: "rejected", reason } : { state: "unavailable", reason: shortError(err) };
    }
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    let nonce: number;
    try {
      [fees, nonce] = await Promise.all([client.estimateFeesPerGas(), this.nextNonce()]);
    } catch (err) {
      return { state: "unavailable", reason: shortError(err) };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await account.signTransaction({
        chainId: this.d.chainId,
        type: "eip1559",
        to: factory,
        data: req.data,
        value: 0n,
        nonce,
        gas: (gas * GAS_BUFFER_BPS) / 10_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const hash = keccak256(raw);
      // Persist before broadcasting: if the RPC call is ambiguous (timeout) the tx can still be re-sent/found.
      await this.d.store.putTx(hash, { raw, nonce, kind: req.kind, ref: req.ref, sentAt: this.now() });
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (err) {
        const msg = shortError(err).toLowerCase();
        if (msg.includes("already known")) {
          // identical tx already in the pool: treat as sent
        } else if (err instanceof BaseError && err.walk((e) => e instanceof NonceTooLowError) && attempt === 0) {
          await this.d.store.deleteTx(hash);
          nonce = await this.d.client.getTransactionCount({ address: this.address, blockTag: "pending" });
          continue;
        } else if (
          err instanceof BaseError &&
          (err.walk((e) => e instanceof InsufficientFundsError) ||
            revertReason(err) !== null ||
            DEFINITE_REJECTION.test(msg))
        ) {
          await this.d.store.deleteTx(hash);
          const reason = revertReason(err);
          return reason ? { state: "rejected", reason } : { state: "unavailable", reason: shortError(err) };
        }
        // Anything else is ambiguous (network): keep the raw tx; reconciliation re-sends or finds it.
      }
      await this.d.store.putNonce(nonce + 1);
      await this.journal({ hash, kind: req.kind, ref: req.ref, nonce, status: "sent", at: this.now() });
      return { state: "sent", hash };
    }
    return { state: "unavailable", reason: "nonce_conflict" };
  }

  private async awaitReceipt(hash: Hex, waitMs: number): Promise<ReceiptResult> {
    try {
      const r = await this.d.client.waitForTransactionReceipt({
        hash,
        timeout: waitMs,
        pollingInterval: Math.min(250, Math.max(50, Math.floor(waitMs / 5))),
        retryCount: 0,
      });
      return await this.settleReceipt(hash, r);
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) return { state: "pending", hash };
      return { state: "pending", hash };
    }
  }

  private async settleReceipt(hash: Hex, r: TransactionReceipt): Promise<ReceiptResult> {
    const tx = await this.d.store.getTx(hash);
    const base = { hash, kind: tx?.kind ?? ("register" as TxKind), ref: tx?.ref ?? "", nonce: tx?.nonce ?? -1 };
    await this.d.store.deleteTx(hash);
    if (r.status === "success") {
      await this.journal({ ...base, status: "confirmed", at: this.now() });
      return { state: "confirmed", hash, blockNumber: r.blockNumber.toString(), logs: toLogs(r) };
    }
    await this.journal({ ...base, status: "reverted", error: "reverted", at: this.now() });
    return { state: "reverted", hash, reason: "reverted on-chain" };
  }

  /**
   * Receipt lookup with reconciliation: if the tx is unknown to the node but still in our raw-tx store and its
   * nonce is unused, re-broadcast it; if the nonce was consumed by another tx, report it as dropped.
   */
  async receipt(hash: Hex, waitMs: number): Promise<ReceiptResult | { state: "unknown"; hash: Hex }> {
    const { client } = this.d;
    try {
      const r = await client.getTransactionReceipt({ hash });
      return await this.settleReceipt(hash, r);
    } catch {
      // not mined yet (or unknown)
    }
    const stored = await this.d.store.getTx(hash);
    try {
      const pendingTx = await client.getTransaction({ hash }).catch(() => null);
      if (!pendingTx && stored) {
        const mined = await client.getTransactionCount({ address: this.address, blockTag: "latest" });
        if (mined > stored.nonce) {
          await this.d.store.deleteTx(hash);
          await this.journal({
            hash,
            kind: stored.kind,
            ref: stored.ref,
            nonce: stored.nonce,
            status: "dropped",
            at: this.now(),
          });
          return { state: "reverted", hash, reason: "dropped (nonce reused)" };
        }
        await client.sendRawTransaction({ serializedTransaction: stored.raw }).catch(() => undefined);
      }
    } catch {
      // RPC trouble: report pending and let the next reconcile retry
    }
    if (!stored && waitMs <= 0) return { state: "unknown", hash };
    return waitMs > 0 ? this.awaitReceipt(hash, waitMs) : { state: "pending", hash };
  }
}
