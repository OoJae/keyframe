import { CAIP2 } from "@keyframe/protocol";
import type { HTTPAdapter, HTTPRequestContext } from "@x402/core/server";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Address } from "viem";
import type { KeyframeFacilitator } from "./facilitator.js";
import { V1_NETWORK } from "./facilitator.js";
import { type DecodedPayment, utf8ToBase64 } from "./payment.js";

// x402 resource server for ALL /v1/orders/{quote_id} (architecture.md §c.2). Determinism: payTo, amount, asset
// and extra come only from the stored final quote (DynamicPayTo/DynamicPrice); the resource URL is
// PUBLIC_BASE_URL + canonical path; the adapter exposes no request headers except the payment signature and
// forces Accept: application/json (no HTML paywall), so the 402 is byte-identical for every method/header set.

export const MAX_TIMEOUT_SECONDS = 300;
export const RESOURCE_MIME = "application/json";
const USDC_EXTRA = { name: "USD Coin", version: "2" } as const;

/** What the 402 is built from: immutable fields of a final quote. */
export interface ChargeableQuote {
  quoteId: string;
  escrow: Address;
  amount: string;
  url: string;
  description: string;
}

class CanonicalAdapter implements HTTPAdapter {
  readonly quote: ChargeableQuote;
  private readonly method: string;
  private readonly paymentSignature: string | undefined;
  constructor(quote: ChargeableQuote, method: string, paymentSignature: string | undefined) {
    this.quote = quote;
    this.method = method;
    this.paymentSignature = paymentSignature;
  }
  getHeader(name: string): string | undefined {
    return name.toLowerCase() === "payment-signature" ? this.paymentSignature : undefined;
  }
  getMethod(): string {
    return this.method;
  }
  getPath(): string {
    return `/v1/orders/${this.quote.quoteId}`;
  }
  getUrl(): string {
    return this.quote.url;
  }
  getAcceptHeader(): string {
    return RESOURCE_MIME;
  }
  getUserAgent(): string {
    return "";
  }
  getQueryParams(): Record<string, string | string[]> {
    return {};
  }
  getQueryParam(): undefined {
    return undefined;
  }
  getBody(): undefined {
    return undefined;
  }
}

const quoteOf = (ctx: HTTPRequestContext): ChargeableQuote => (ctx.adapter as CanonicalAdapter).quote;

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type VerifyOutcome =
  | { ok: true; payload: PaymentPayload; requirements: PaymentRequirements; settle: () => Promise<SettleOutcome> }
  | { ok: false; response: WireResponse };

export type SettleOutcome =
  | { ok: true; transaction: string; headers: Record<string, string> }
  | { ok: false; reason: string; response: WireResponse };

const toWire = (r: { status: number; headers: Record<string, string>; body?: unknown }): WireResponse => ({
  status: r.status,
  headers: r.headers,
  body: typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}),
});

export function v2Requirement(q: ChargeableQuote, usdc: Address): PaymentRequirements {
  return {
    scheme: "exact",
    network: CAIP2,
    amount: q.amount,
    asset: usdc,
    payTo: q.escrow,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { ...USDC_EXTRA },
  };
}

export function v1Requirement(q: ChargeableQuote, usdc: Address) {
  // Same field order as @keyframe/protocol buildPaymentRequiredV1.
  return {
    scheme: "exact",
    network: V1_NETWORK,
    maxAmountRequired: q.amount,
    resource: q.url,
    description: q.description,
    mimeType: RESOURCE_MIME,
    payTo: q.escrow,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: usdc,
    extra: { ...USDC_EXTRA },
  };
}

/**
 * Tolerant match: x402 core matches the echoed `accepted` by exact deep equality. `accepted` is unsigned
 * metadata, so when it differs only cosmetically (address case, key order, missing extra) but the SIGNED
 * authorization pays exactly our E and amount, substitute our requirement before matching.
 */
export function canonicalizeAccepted(p: DecodedPayment, ours: PaymentRequirements): string {
  const accepted = p.payload.accepted as Record<string, unknown> | undefined;
  if (!accepted || typeof accepted !== "object") return p.raw;
  const same =
    accepted.scheme === ours.scheme &&
    accepted.network === ours.network &&
    String(accepted.amount) === ours.amount &&
    typeof accepted.payTo === "string" &&
    accepted.payTo.toLowerCase() === ours.payTo.toLowerCase() &&
    typeof accepted.asset === "string" &&
    accepted.asset.toLowerCase() === ours.asset.toLowerCase() &&
    p.authorization.to.toLowerCase() === ours.payTo.toLowerCase() &&
    p.authorization.value === ours.amount;
  if (!same) return p.raw;
  return utf8ToBase64(JSON.stringify({ ...p.payload, accepted: ours }));
}

export class X402Runtime {
  readonly facilitator: KeyframeFacilitator;
  private readonly usdc: Address;
  private readonly resourceServer: x402ResourceServer;
  private ready: Promise<void> | null = null;

  constructor(facilitator: KeyframeFacilitator, usdc: Address) {
    this.facilitator = facilitator;
    this.usdc = usdc;
    this.resourceServer = new x402ResourceServer(facilitator);
    this.resourceServer.register(CAIP2, new ExactEvmScheme());
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.resourceServer.initialize();
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  /** One route, built per quote so the description is per-quote; payTo/price are dynamic from the quote. */
  private async http(q: ChargeableQuote): Promise<x402HTTPResourceServer> {
    await this.init();
    return new x402HTTPResourceServer(this.resourceServer, {
      "/v1/orders/:quoteId": {
        accepts: {
          scheme: "exact",
          network: CAIP2,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          payTo: (ctx) => quoteOf(ctx).escrow,
          price: (ctx) => ({ amount: quoteOf(ctx).amount, asset: this.usdc, extra: { ...USDC_EXTRA } }),
        },
        description: q.description,
        mimeType: RESOURCE_MIME,
      },
    });
  }

  private context(q: ChargeableQuote, method: string, paymentSignature?: string): HTTPRequestContext {
    const adapter = new CanonicalAdapter(q, method, paymentSignature);
    return { adapter, path: adapter.getPath(), method };
  }

  /** The unpaid 402 (v2: PAYMENT-REQUIRED header + `{}`; v1: JSON body only). */
  async challenge(q: ChargeableQuote, wire: "v1" | "v2"): Promise<WireResponse> {
    // v1 body is emitted here (not via the protocol builder) so a USDC_ADDRESS override stays consistent;
    // with canonical USDC it is byte-identical to buildPaymentRequiredV1 (tested).
    if (wire === "v1") return this.v1Error(q, "Payment required");
    const http = await this.http(q);
    const r = await http.processHTTPRequest(this.context(q, "GET"));
    if (r.type !== "payment-error") throw new Error(`x402: unexpected unpaid result ${r.type}`);
    return toWire(r.response);
  }

  /** v2: x402 core matching + local verification. On success, `settle()` runs processSettlement. */
  async verifyV2(q: ChargeableQuote, p: DecodedPayment, method: string): Promise<VerifyOutcome> {
    const http = await this.http(q);
    const header = canonicalizeAccepted(p, v2Requirement(q, this.usdc));
    const ctx = this.context(q, method, header);
    const r = await http.processHTTPRequest(ctx);
    if (r.type === "payment-error") return { ok: false, response: toWire(r.response) };
    if (r.type !== "payment-verified") throw new Error(`x402: unexpected paid result ${r.type}`);
    return {
      ok: true,
      payload: r.paymentPayload,
      requirements: r.paymentRequirements,
      settle: async () => {
        const s = await http.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, {
          request: ctx,
        });
        if (s.success) return { ok: true, transaction: s.transaction, headers: s.headers };
        return { ok: false, reason: s.errorReason, response: toWire(s.response) };
      },
    };
  }

  /** v1 (X-PAYMENT): same verifier and settlement, v1 envelopes. */
  async verifyV1(q: ChargeableQuote, p: DecodedPayment): Promise<VerifyOutcome> {
    const requirements = v1Requirement(q, this.usdc) as unknown as PaymentRequirements;
    const payload = p.payload as unknown as PaymentPayload;
    const reject = (error: string): VerifyOutcome => ({ ok: false, response: this.v1Error(q, error) });
    const pv = p.payload as { scheme?: unknown; network?: unknown };
    if (pv.scheme !== "exact" || pv.network !== V1_NETWORK) return reject("unsupported_scheme_or_network");
    let v: Awaited<ReturnType<KeyframeFacilitator["verify"]>>;
    try {
      v = await this.facilitator.verify(payload, requirements);
    } catch (e) {
      return reject(e instanceof Error ? e.message.slice(0, 120) : "verify_failed");
    }
    if (!v.isValid) return reject(v.invalidReason ?? "invalid_payment");
    return {
      ok: true,
      payload,
      requirements,
      settle: async () => {
        const s = await this.facilitator.settle(payload, requirements);
        const header = { "X-PAYMENT-RESPONSE": utf8ToBase64(JSON.stringify(s)) };
        if (s.success) return { ok: true, transaction: s.transaction, headers: header };
        const response = this.v1Error(q, s.errorReason ?? "settlement_failed");
        return { ok: false, reason: s.errorReason ?? "settlement_failed", response };
      },
    };
  }

  private v1Error(q: ChargeableQuote, error: string): WireResponse {
    return {
      status: 402,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ x402Version: 1, error, accepts: [v1Requirement(q, this.usdc)] }),
    };
  }
}
