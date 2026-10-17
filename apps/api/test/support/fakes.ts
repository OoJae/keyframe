import { escrowOf, hashTerms, keyframeFactoryAbi, Status, type Terms, USDC } from "@keyframe/protocol";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { type Address, decodeFunctionData, type Hex, keccak256, toHex } from "viem";
import type { ChainReader, OrderEvent, OrderView, TokenTransfer } from "../../src/chain.js";
import type { ReceiptResult, RelayerClient, RelayRequest, RelayResult } from "../../src/relayer/types.js";
import type { StorageAdapter, StoredObject } from "../../src/storage.js";

// In-memory stand-ins for the factory (state machine of frozen §3, enough to drive the API), the relayer DO and
// the chain reader. Calldata is decoded with the real ABI, so these tests also prove what the API would send.

const ZERO = `0x${"0".repeat(64)}` as Hex;
const GRACE = 3 * 86_400;

const emptyView = (): OrderView => ({
  status: Status.None,
  buyer: "0x0000000000000000000000000000000000000000",
  deadline: 0n,
  reviewWindow: 0,
  openedAt: 0n,
  deliveredAt: 0n,
  finalAt: 0n,
  accepted: false,
  key: ZERO,
  manifestHash: ZERO,
  toSeller: 0n,
  toBuyer: 0n,
});

type TupleTerms = Omit<Terms, "dueAt" | "deadline"> & { dueAt: bigint; deadline: bigint };
const fromTuple = (t: TupleTerms): Terms => ({ ...t, dueAt: Number(t.dueAt), deadline: Number(t.deadline) });

/** Default sender the fake reports for USDC that reached an escrow without an explicit transfer record. */
export const UNKNOWN_DEPOSITOR = "0x00000000000000000000000000000000000dE905" as Address;

export class FakeFactory {
  readonly views = new Map<string, OrderView>();
  readonly balances = new Map<string, bigint>();
  readonly paidToSeller = new Map<string, bigint>();
  /** USDC Transfer logs into an escrow (lowercase); when absent the balance is reported as one unknown deposit. */
  readonly transfers = new Map<string, TokenTransfer[]>();
  /** EIP-3009 authorizations executed by fundWithAuthorization ("from:nonce", lowercase). */
  readonly usedAuthorizations = new Set<string>();
  /** termsHashes refundExpired cannot clear (e.g. a blacklisted buyer under an older factory). */
  readonly stuck = new Set<string>();
  readonly factory: Address;
  readonly nowS: () => number;
  constructor(factory: Address, nowS: () => number) {
    this.factory = factory;
    this.nowS = nowS;
  }

  view(h: string): OrderView {
    return this.views.get(h.toLowerCase()) ?? emptyView();
  }
  private set(h: string, v: OrderView) {
    this.views.set(h.toLowerCase(), v);
  }
  private escrow(t: Terms) {
    return escrowOf(hashTerms(t, this.factory), this.factory).toLowerCase();
  }
  balance(t: Terms): bigint {
    return this.balances.get(this.escrow(t)) ?? 0n;
  }

  /** Executes one factory call; returns a revert reason or null. */
  apply(data: Hex): string | null {
    const call = decodeFunctionData({ abi: keyframeFactoryAbi, data });
    const now = BigInt(this.nowS());
    if (call.functionName === "refundExpired") {
      for (const h of this.refundableExpired(Number(call.args[0] as bigint))) {
        const v = this.view(h);
        this.set(h, { ...v, status: Status.Refunded, finalAt: now });
      }
      return null;
    }
    const t = fromTuple(call.args[0] as TupleTerms);
    const h = hashTerms(t, this.factory);
    const v = this.view(h);
    const e = this.escrow(t);
    switch (call.functionName) {
      case "fundWithAuthorization":
        if (v.status !== Status.None) return "AlreadyRegistered()";
        this.usedAuthorizations.add(`${t.buyer.toLowerCase()}:${String(call.args[3]).toLowerCase()}`);
        this.balances.set(e, (this.balances.get(e) ?? 0n) + t.amount);
        this.set(h, {
          ...v,
          status: Status.Open,
          buyer: t.buyer,
          deadline: BigInt(t.deadline),
          reviewWindow: t.reviewWindow,
          openedAt: now,
        });
        return null;
      case "register":
        if (v.status !== Status.None) return "AlreadyRegistered()";
        if (this.balance(t) < t.amount) return "Underfunded";
        this.set(h, {
          ...v,
          status: Status.Open,
          buyer: t.buyer,
          deadline: BigInt(t.deadline),
          reviewWindow: t.reviewWindow,
          openedAt: now,
        });
        return null;
      case "release": {
        const [, key, charge, manifestHash] = call.args as [unknown, Hex, bigint, Hex];
        if (keccak256(key) !== t.keyHash) return "BadKey()";
        const studioOk =
          t.reviewWindow > 0 &&
          v.status === Status.Delivered &&
          (v.accepted || now >= v.deliveredAt + BigInt(t.reviewWindow));
        const instantOk = t.reviewWindow === 0 && v.status === Status.Open && now <= BigInt(t.deadline);
        if (!studioOk && !instantOk) return `BadStatus(${v.status})`;
        if (t.contentHash !== ZERO && manifestHash !== t.contentHash) return "ManifestMismatch()";
        if (charge > t.amount) return "ChargeTooHigh";
        const bal = this.balance(t);
        this.balances.set(e, 0n);
        this.paidToSeller.set(h, charge);
        this.set(h, {
          ...v,
          status: Status.Released,
          key,
          manifestHash,
          toSeller: charge,
          toBuyer: bal - charge,
          finalAt: now,
        });
        return null;
      }
      case "deliver": {
        if (v.status !== Status.Open || t.reviewWindow === 0) return `BadStatus(${v.status})`;
        const [, manifestHash] = call.args as [unknown, Hex];
        this.set(h, { ...v, status: Status.Delivered, deliveredAt: now, manifestHash });
        return null;
      }
      case "decideBySig": {
        if (v.status !== Status.Delivered) return `BadStatus(${v.status})`;
        const accept = call.args[1] as boolean;
        if (accept) this.set(h, { ...v, accepted: true });
        else {
          const bal = this.balance(t);
          this.balances.set(e, 0n);
          this.set(h, { ...v, status: Status.Rejected, toBuyer: bal, finalAt: now });
        }
        return null;
      }
      case "refund": {
        const open = (v.status === Status.None || v.status === Status.Open) && now > BigInt(t.deadline);
        const late = v.status === Status.Delivered && now > v.deliveredAt + BigInt(t.reviewWindow) + BigInt(GRACE);
        if (!open && !late) return "TooEarly";
        const bal = this.balance(t);
        this.balances.set(e, 0n);
        this.set(h, { ...v, status: Status.Refunded, toBuyer: bal, finalAt: now });
        return null;
      }
      case "cancel": {
        const bal = this.balance(t);
        this.balances.set(e, 0n);
        this.set(h, { ...v, status: Status.Cancelled, toBuyer: bal, finalAt: now });
        return null;
      }
      default:
        return `unsupported ${call.functionName}`;
    }
  }

  /** What refundExpired(maxScan) would refund now (Open past the deadline, not stuck). */
  refundableExpired(maxScan: number): string[] {
    const now = BigInt(this.nowS());
    const out: string[] = [];
    for (const [h, v] of this.views) {
      if (out.length >= maxScan) break;
      if (v.status === Status.Open && now > v.deadline && !this.stuck.has(h)) out.push(h);
    }
    return out;
  }
}

let txCounter = 0;
const fakeHash = (): Hex => toHex(BigInt(++txCounter), { size: 32 });

export type RelayOverride = (req: RelayRequest) => RelayResult | undefined;

export class StubRelayer implements RelayerClient {
  readonly sends: RelayRequest[] = [];
  readonly factory: FakeFactory;
  /** Return a result to short-circuit; undefined = execute against the fake factory. */
  override: RelayOverride | null = null;
  /** Hashes answered "pending" until `mine(hash)`. */
  readonly pending = new Set<string>();
  /** When set, sends answer "pending" (tx executed only on mine). */
  slowReceipts = false;
  private readonly queued = new Map<string, Hex>();

  constructor(factory: FakeFactory) {
    this.factory = factory;
  }

  count(kind: RelayRequest["kind"]): number {
    return this.sends.filter((r) => r.kind === kind).length;
  }

  async send(req: RelayRequest): Promise<RelayResult> {
    this.sends.push(req);
    await new Promise((r) => setTimeout(r, 2));
    const o = this.override?.(req);
    if (o) return o;
    if (this.slowReceipts) {
      const hash = fakeHash();
      this.pending.add(hash);
      this.queued.set(hash, req.data);
      return { state: "pending", hash };
    }
    const reason = this.factory.apply(req.data);
    if (reason) return { state: "rejected", reason };
    return { state: "confirmed", hash: fakeHash(), blockNumber: "1", logs: [] };
  }

  /** Mine a pending tx (executes it against the fake factory). */
  mine(hash: string): void {
    const data = this.queued.get(hash);
    if (data) this.factory.apply(data);
    this.pending.delete(hash);
    this.queued.delete(hash);
  }

  async receipt(hash: Hex): Promise<ReceiptResult> {
    if (this.pending.has(hash)) return { state: "pending", hash };
    return { state: "confirmed", hash, blockNumber: "1", logs: [] };
  }
}

export interface StubChainOptions {
  /** Throw from the EIP-3009 simulation (e.g. insufficient balance). */
  simulationError?: Error;
}

export class StubChain implements ChainReader {
  readonly factory: FakeFactory;
  opts: StubChainOptions = {};
  constructor(factory: FakeFactory) {
    this.factory = factory;
  }
  async orderOf(_f: Address, h: Hex) {
    return this.factory.view(h);
  }
  async balanceOf(_token: Address, account: Address) {
    return this.factory.balances.get(account.toLowerCase()) ?? 0n;
  }
  async refundableCount() {
    const now = BigInt(this.factory.nowS());
    let n = 0n;
    for (const v of this.factory.views.values()) if (v.status === Status.Open && now > v.deadline) n++;
    return n;
  }
  async simulateRefundExpired(_f: Address, maxScan: number) {
    return BigInt(this.factory.refundableExpired(maxScan).length);
  }
  async authorizationState(_token: Address, authorizer: Address, nonce: Hex) {
    return this.factory.usedAuthorizations.has(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
  }
  async transfersTo(_token: Address, to: Address): Promise<TokenTransfer[]> {
    const e = to.toLowerCase();
    const recorded = this.factory.transfers.get(e);
    if (recorded) return recorded;
    const bal = this.factory.balances.get(e) ?? 0n;
    return bal > 0n ? [{ from: UNKNOWN_DEPOSITOR, value: bal, tx: `0x${"de".repeat(32)}` as Hex }] : [];
  }
  /** Tx of the factory event for T: Opened → 0x0e…; a terminal event → 0xee… while T is in that state. */
  async eventTx(_f: Address, event: OrderEvent, h: Hex) {
    if (event === "Opened") return `0x${"0e".repeat(32)}` as Hex;
    const st: Partial<Record<OrderEvent, number>> = {
      Released: Status.Released,
      Refunded: Status.Refunded,
      Cancelled: Status.Cancelled,
      Decided: Status.Rejected,
    };
    return st[event] === this.factory.view(h).status ? (`0x${"ee".repeat(32)}` as Hex) : null;
  }
  async blockTimestamp() {
    return BigInt(this.factory.nowS());
  }
  async verifyTypedData() {
    return false;
  }
  async verifyMessage() {
    return false;
  }
  async getCode() {
    return undefined;
  }
  async openedTx() {
    return `0x${"0e".repeat(32)}` as Hex;
  }
  x402Signer(addresses: readonly Address[]): FacilitatorEvmSigner {
    const fail = (): never => {
      throw new Error("read-only");
    };
    return {
      getAddresses: () => addresses,
      readContract: async (args) => {
        if (args.functionName === "transferWithAuthorization" && this.opts.simulationError)
          throw this.opts.simulationError;
        if (args.functionName === "balanceOf") return 10n ** 12n;
        if (args.functionName === "authorizationState") return false;
        if (args.functionName === "name") return "USD Coin";
        if (args.functionName === "version") return "2";
        return undefined;
      },
      verifyTypedData: async () => false,
      getCode: async ({ address }) => (address.toLowerCase() === USDC.toLowerCase() ? "0x6080" : undefined),
      waitForTransactionReceipt: fail,
      writeContract: fail,
      sendTransaction: fail,
    };
  }
}

export class MemoryStorage implements StorageAdapter {
  readonly kind = "memory";
  readonly objects = new Map<string, StoredObject>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
