import { CAIP2, keyframeFactoryAbi, Status, type Terms } from "@keyframe/protocol";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/facilitator";
import { type Address, encodeFunctionData, type Hex, isAddressEqual } from "viem";
import type { ChainReader } from "../chain.js";
import { errorText } from "../redact.js";
import type { RelayerClient } from "../relayer/types.js";

// Contract-as-facilitator (architecture.md §c.4): verification is local (x402's own exact-EVM verifier with a
// read-only signer: signature, to == E, value == amount, validity window, eth_call simulation); settlement is
// factory.fundWithAuthorization(T, …) through the relayer, which moves the buyer's USDC to E and registers T in
// one transaction. If the relayer cannot broadcast, PayAI settles a plain transferWithAuthorization to E and
// the keeper registers T afterwards. Never x402.org.

export interface SettleTarget {
  terms: Terms;
  termsHash: Hex;
}

export interface SettleDetail {
  rail: "relayer" | "payai";
  funding: "confirmed" | "pending";
  tx: Hex;
}

/**
 * What a settlement attempt did, as far as money is concerned. `settled`: funds moved (or are moving) into E.
 * `ambiguous`: the outcome is unknown (the relayer call threw after a possible broadcast, the fallback timed out):
 * the claim must stay, never be reopened, until the chain says otherwise. No entry: nothing moved.
 */
export type SettleRecord = { kind: "settled"; detail: SettleDetail } | { kind: "ambiguous"; reason: string };

export interface FacilitatorDeps {
  signer: () => FacilitatorEvmSigner;
  relayer: RelayerClient;
  fallback: FacilitatorClient | null;
  receiptWaitMs: number;
  /** For the already-registered case (ADR-004): read order(termsHash) and find the opening tx. */
  chain: ChainReader | null;
  factory: Address;
  /** USDC (authorizationState / balance checks after an unclear fallback). */
  usdc?: Address;
}

export const V1_NETWORK = "base";
/** Placeholder funding tx when the opening transaction is outside the log lookback (funds are verifiably at E). */
const ZERO_TX = `0x${"0".repeat(64)}` as Hex;

export const settleKey = (fromLc: string, nonceLc: string) => `${fromLc}:${nonceLc}`;

const authOf = (p: PaymentPayload) =>
  (p.payload as { authorization: { from: string; validAfter: string; validBefore: string; nonce: Hex } }).authorization;

export function termsTuple(t: Terms) {
  return {
    ...t,
    dueAt: BigInt(t.dueAt),
    deadline: BigInt(t.deadline),
  };
}

export class KeyframeFacilitator implements FacilitatorClient {
  private readonly targets = new Map<string, SettleTarget>();
  private readonly outcomes = new Map<string, SettleRecord>();

  private readonly d: FacilitatorDeps;

  constructor(deps: FacilitatorDeps) {
    this.d = deps;
  }

  /** The paid path registers what a (from, nonce) settles into before calling processSettlement. */
  expect(key: string, target: SettleTarget): void {
    this.targets.set(key, target);
  }

  /** What the settlement of `key` did (consumed once); undefined ⇒ nothing moved. */
  take(key: string): SettleRecord | undefined {
    const o = this.outcomes.get(key);
    this.outcomes.delete(key);
    this.targets.delete(key);
    return o;
  }

  /**
   * fundWithAuthorization reverts AlreadyRegistered when T was opened by an earlier call (ours whose response was
   * lost, or a front-runner holding the same authorization). If the chain shows T open for this buyer, the money
   * is at E and the order is real: report success with the opening transaction.
   */
  private async alreadyOpen(
    target: SettleTarget,
    ok: (d: SettleDetail) => SettleResponse,
    fail: (reason: string) => SettleResponse,
    ambiguous: (reason: string) => SettleResponse,
  ): Promise<SettleResponse> {
    const chain = this.d.chain;
    // T is registered, so E may hold the money: without a chain read this is not a refusal.
    if (!chain) return ambiguous("AlreadyRegistered() and no chain reader");
    let v: Awaited<ReturnType<ChainReader["orderOf"]>>;
    try {
      v = await chain.orderOf(this.d.factory, target.termsHash);
    } catch {
      return ambiguous("AlreadyRegistered() and order() unreadable");
    }
    if (v.status !== Status.Open || !isAddressEqual(v.buyer, target.terms.buyer)) {
      return fail(`funding_rejected: AlreadyRegistered() (status ${v.status})`);
    }
    const tx = await chain.openedTx(this.d.factory, target.termsHash).catch(() => null);
    return ok({ rail: "relayer", funding: "confirmed", tx: tx ?? ZERO_TX });
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        { x402Version: 2, scheme: "exact", network: CAIP2 },
        // v1 networks are bare names; the core type only models CAIP-2.
        { x402Version: 1, scheme: "exact", network: V1_NETWORK as `${string}:${string}` },
      ],
      extensions: [],
      signers: {},
    };
  }

  /**
   * x402's exact verifier, restricted to plain EIP-3009: a payload carrying anything else (Permit2) is refused, and
   * the payer the verifier reports must be the authorization's `from`, which every business check and settlement
   * reads.
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const inner = payload.payload as Record<string, unknown>;
    const from = (inner?.authorization as { from?: unknown } | undefined)?.from;
    if (
      typeof from !== "string" ||
      typeof inner.signature !== "string" ||
      Object.keys(inner).some((k) => k !== "authorization" && k !== "signature")
    ) {
      return { isValid: false, invalidReason: "unsupported_payload_type" } as VerifyResponse;
    }
    const signer = this.d.signer();
    const res =
      payload.x402Version === 1
        ? await new ExactEvmSchemeV1(signer).verify(payload, requirements)
        : await new ExactEvmScheme(signer).verify(payload, requirements);
    if (res.isValid && (typeof res.payer !== "string" || res.payer.toLowerCase() !== from.toLowerCase())) {
      return { isValid: false, invalidReason: "payer_mismatch", payer: res.payer } as VerifyResponse;
    }
    return res;
  }

  /**
   * After an unclear fallback: did the authorization execute anyway? Used ⇒ the money is at E (EIP-3009 `to` is E).
   * Unknown (no chain, RPC error) ⇒ null.
   */
  private async authorizationUsed(from: Address, nonce: Hex, escrow: Address, amount: bigint): Promise<boolean | null> {
    const chain = this.d.chain;
    if (!chain || !this.d.usdc) return null;
    try {
      if (await chain.authorizationState(this.d.usdc, from, nonce)) return true;
      return (await chain.balanceOf(this.d.usdc, escrow)) >= amount;
    } catch {
      return null;
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const auth = authOf(payload);
    const key = settleKey(auth.from.toLowerCase(), auth.nonce.toLowerCase());
    const network = requirements.network;
    const fail = (errorReason: string, transaction = ""): SettleResponse => ({
      success: false,
      errorReason,
      transaction,
      network,
      payer: auth.from,
    });
    const target = this.targets.get(key);
    if (!target) return fail("unexpected_settlement");

    const signature = (payload.payload as { signature: Hex }).signature;
    const data = encodeFunctionData({
      abi: keyframeFactoryAbi,
      functionName: "fundWithAuthorization",
      args: [termsTuple(target.terms), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, signature],
    });
    const ok = (detail: SettleDetail): SettleResponse => {
      this.outcomes.set(key, { kind: "settled", detail });
      return { success: true, transaction: detail.tx, network, payer: auth.from };
    };
    const ambiguous = (reason: string): SettleResponse => {
      this.outcomes.set(key, { kind: "ambiguous", reason });
      return fail(`settlement_unconfirmed: ${reason}`);
    };
    let r: Awaited<ReturnType<RelayerClient["send"]>>;
    try {
      r = await this.d.relayer.send({ kind: "fund", ref: target.termsHash, data, waitMs: this.d.receiptWaitMs });
    } catch (e) {
      // The Durable Object call failed (reset, network): it may have broadcast before failing. Never "not charged".
      return ambiguous(`relayer_call_failed: ${errorText(e, 120)}`);
    }
    switch (r.state) {
      case "confirmed":
        return ok({ rail: "relayer", funding: "confirmed", tx: r.hash });
      case "pending":
        return ok({ rail: "relayer", funding: "pending", tx: r.hash });
      case "reverted":
        return fail("funding_reverted", r.hash);
      case "rejected":
        if (r.reason.startsWith("AlreadyRegistered")) return this.alreadyOpen(target, ok, fail, ambiguous);
        return fail(`funding_rejected: ${r.reason}`);
      case "unavailable": {
        if (!this.d.fallback) return fail("relayer_unavailable");
        const escrow = requirements.payTo as Address;
        const amount = target.terms.amount;
        let s: SettleResponse | null = null;
        let threw: string | null = null;
        try {
          s = await this.d.fallback.settle(payload, requirements);
        } catch (e) {
          threw = e instanceof Error ? e.name : "error";
        }
        if (s?.success && /^0x[0-9a-fA-F]{64}$/.test(s.transaction)) {
          return ok({ rail: "payai", funding: "confirmed", tx: s.transaction as Hex });
        }
        // A timeout or an unclear answer may still have executed the authorization: check before failing.
        const used = await this.authorizationUsed(auth.from as Address, auth.nonce, escrow, amount);
        if (used === true) {
          const tx = s && /^0x[0-9a-fA-F]{64}$/.test(s.transaction) ? (s.transaction as Hex) : ZERO_TX;
          return ok({ rail: "payai", funding: "confirmed", tx });
        }
        if (threw !== null || used === null)
          return ambiguous(`fallback_unclear: ${threw ?? s?.errorReason ?? "unknown"}`);
        return fail(`fallback_failed: ${s?.errorReason ?? "unknown"}`, s?.transaction ?? "");
      }
    }
  }
}
