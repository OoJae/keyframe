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

export interface FacilitatorDeps {
  signer: () => FacilitatorEvmSigner;
  relayer: RelayerClient;
  fallback: FacilitatorClient | null;
  receiptWaitMs: number;
  /** For the already-registered case (ADR-004): read order(termsHash) and find the opening tx. */
  chain: ChainReader | null;
  factory: Address;
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
  private readonly outcomes = new Map<string, SettleDetail>();

  private readonly d: FacilitatorDeps;

  constructor(deps: FacilitatorDeps) {
    this.d = deps;
  }

  /** The paid path registers what a (from, nonce) settles into before calling processSettlement. */
  expect(key: string, target: SettleTarget): void {
    this.targets.set(key, target);
  }

  /** Rail/funding details of a settlement (consumed once). */
  take(key: string): SettleDetail | undefined {
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
  ): Promise<SettleResponse> {
    const chain = this.d.chain;
    if (!chain) return fail("funding_rejected: AlreadyRegistered()");
    try {
      const v = await chain.orderOf(this.d.factory, target.termsHash);
      if (v.status !== Status.Open || !isAddressEqual(v.buyer, target.terms.buyer)) {
        return fail(`funding_rejected: AlreadyRegistered() (status ${v.status})`);
      }
      const tx = await chain.openedTx(this.d.factory, target.termsHash).catch(() => null);
      return ok({ rail: "relayer", funding: "confirmed", tx: tx ?? ZERO_TX });
    } catch {
      return fail("funding_rejected: AlreadyRegistered()");
    }
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

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const signer = this.d.signer();
    if (payload.x402Version === 1) {
      return new ExactEvmSchemeV1(signer).verify(payload, requirements);
    }
    return new ExactEvmScheme(signer).verify(payload, requirements);
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
    const r = await this.d.relayer.send({ kind: "fund", ref: target.termsHash, data, waitMs: this.d.receiptWaitMs });
    const ok = (detail: SettleDetail): SettleResponse => {
      this.outcomes.set(key, detail);
      return { success: true, transaction: detail.tx, network, payer: auth.from };
    };
    switch (r.state) {
      case "confirmed":
        return ok({ rail: "relayer", funding: "confirmed", tx: r.hash });
      case "pending":
        return ok({ rail: "relayer", funding: "pending", tx: r.hash });
      case "reverted":
        return fail("funding_reverted", r.hash);
      case "rejected":
        if (r.reason.startsWith("AlreadyRegistered")) return this.alreadyOpen(target, ok, fail);
        return fail(`funding_rejected: ${r.reason}`);
      case "unavailable": {
        if (!this.d.fallback) return fail("relayer_unavailable");
        try {
          const s = await this.d.fallback.settle(payload, requirements);
          if (!s.success || !/^0x[0-9a-fA-F]{64}$/.test(s.transaction)) {
            return fail(`fallback_failed: ${s.errorReason ?? "unknown"}`, s.transaction);
          }
          return ok({ rail: "payai", funding: "confirmed", tx: s.transaction as Hex });
        } catch (e) {
          return fail(`fallback_failed: ${e instanceof Error ? e.name : "error"}`);
        }
      }
    }
  }
}
