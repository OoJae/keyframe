// x402 plumbing for the spike: @x402/core x402HTTPResourceServer (v2 wire) plus a hand-written v1 emitter.
//
// Determinism rules (verification.md S2/S6, architecture.md c.2):
//  * payTo / amount / asset / extra come only from the stored, immutable quote;
//  * the resource URL is PUBLIC_BASE_URL + canonical path (never the request's scheme/host/query);
//  * Accept is forced to application/json and the UA is blanked, so the HTML paywall branch never runs;
//  * no timestamps or random values in the challenge; one wire version per response.

import type { FacilitatorClient, HTTPAdapter, HTTPRequestContext } from "@x402/core/server";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import { BASE_USDC, MAX_TIMEOUT_SECONDS, NETWORK_V1, NETWORK_V2, USDC_EXTRA } from "./env.js";

export interface StoredQuote {
  quote_id: string;
  pay_to: `0x${string}`;
  pay_to_index: number;
  amount: string;
  buyer: `0x${string}`;
  created_at: string;
}

export const ROUTE_DESCRIPTION = "Keyframe interop spike order (test payee, recoverable)";
export const ROUTE_MIME = "application/json";

export const ordersPath = (quoteId: string): string => `/v1/orders/${quoteId}`;

/**
 * Facilitator wrapper: verify/settle go to the real HTTPFacilitatorClient (PayAI, keyless), but the
 * supported-kinds table is pinned, so building a 402 never depends on a network call (fast + deterministic).
 * Both kinds were confirmed against GET https://facilitator.payai.network/supported.
 */
class PinnedSupportFacilitator implements FacilitatorClient {
  constructor(readonly inner: HTTPFacilitatorClient) {}
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.inner.verify(p, r);
  }
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.inner.settle(p, r);
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        { x402Version: 2, scheme: "exact", network: NETWORK_V2 },
        // v1 network ids are bare names ("base"); the core type only models CAIP-2, hence the cast.
        { x402Version: 1, scheme: "exact", network: NETWORK_V1 as unknown as `${string}:${string}` },
      ],
      extensions: [],
      signers: {},
    };
  }
}

/** Adapter that exposes only what x402 needs, canonicalised. */
export class SpikeAdapter implements HTTPAdapter {
  constructor(
    private readonly headers: Headers,
    private readonly method: string,
    readonly quote: StoredQuote,
    private readonly canonicalUrl: string,
    private readonly paymentSignatureOverride?: string,
  ) {}
  getHeader(name: string): string | undefined {
    const lower = name.toLowerCase();
    if (lower === "payment-signature" && this.paymentSignatureOverride !== undefined) return this.paymentSignatureOverride;
    return this.headers.get(lower) ?? undefined;
  }
  getMethod(): string {
    return this.method;
  }
  getPath(): string {
    return ordersPath(this.quote.quote_id);
  }
  getUrl(): string {
    return this.canonicalUrl;
  }
  getAcceptHeader(): string {
    return "application/json";
  }
  getUserAgent(): string {
    return "";
  }
  getQueryParams(): Record<string, string | string[]> {
    return {};
  }
  getQueryParam(): string | string[] | undefined {
    return undefined;
  }
  getBody(): unknown {
    return undefined;
  }
}

const quoteOf = (ctx: HTTPRequestContext): StoredQuote => (ctx.adapter as SpikeAdapter).quote;

export interface X402Runtime {
  http: x402HTTPResourceServer;
  facilitator: HTTPFacilitatorClient;
}

let runtime: { key: string; value: Promise<X402Runtime> } | null = null;

export function getX402Runtime(facilitatorUrl: string): Promise<X402Runtime> {
  if (runtime && runtime.key === facilitatorUrl) return runtime.value;
  const value = (async () => {
    const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs: 20_000 });
    const resourceServer = new x402ResourceServer(new PinnedSupportFacilitator(facilitator));
    resourceServer.register(NETWORK_V2, new ExactEvmScheme());
    const http = new x402HTTPResourceServer(resourceServer, {
      // No verb => matches every method (GET/POST/...); the quote id is the only key.
      "/v1/orders/:id": {
        accepts: {
          scheme: "exact",
          network: NETWORK_V2,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          payTo: (ctx) => quoteOf(ctx).pay_to,
          price: (ctx) => ({ amount: quoteOf(ctx).amount, asset: BASE_USDC, extra: { ...USDC_EXTRA } }),
        },
        description: ROUTE_DESCRIPTION,
        mimeType: ROUTE_MIME,
      },
    });
    await http.initialize();
    return { http, facilitator };
  })();
  runtime = { key: facilitatorUrl, value };
  value.catch(() => {
    if (runtime?.value === value) runtime = null;
  });
  return value;
}

export function makeContext(adapter: SpikeAdapter): HTTPRequestContext {
  return { adapter, path: adapter.getPath(), method: adapter.getMethod() };
}

// ---------------------------------------------------------------- v1 wire (custom emitter)

export interface PaymentRequirementsV1Wire {
  scheme: "exact";
  network: typeof NETWORK_V1;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: Record<string, unknown>;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
}

export function v1Requirements(quote: StoredQuote, canonicalUrl: string): PaymentRequirementsV1Wire {
  // Field order is fixed so JSON.stringify output is byte-stable.
  return {
    scheme: "exact",
    network: NETWORK_V1,
    maxAmountRequired: quote.amount,
    resource: canonicalUrl,
    description: ROUTE_DESCRIPTION,
    mimeType: ROUTE_MIME,
    outputSchema: { input: { type: "http", method: "POST" }, output: null },
    payTo: quote.pay_to,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: BASE_USDC,
    extra: { ...USDC_EXTRA },
  };
}

export function v1PaymentRequiredBody(quote: StoredQuote, canonicalUrl: string, error = "X-PAYMENT header is required"): string {
  return JSON.stringify({ x402Version: 1, error, accepts: [v1Requirements(quote, canonicalUrl)] });
}

// ---------------------------------------------------------------- payment header inspection

export interface DecodedPayment {
  headerName: "PAYMENT-SIGNATURE" | "X-PAYMENT" | null;
  raw: string | null;
  version: number | null;
  payload: Record<string, unknown> | null;
  from: string | null;
  nonce: string | null;
}

function base64ToUtf8(value: string): string {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodePaymentHeaders(headers: Headers): DecodedPayment {
  const v2 = headers.get("payment-signature");
  const v1 = headers.get("x-payment");
  const headerName = v2 ? "PAYMENT-SIGNATURE" : v1 ? "X-PAYMENT" : null;
  const raw = v2 ?? v1 ?? null;
  const empty: DecodedPayment = { headerName, raw, version: null, payload: null, from: null, nonce: null };
  if (!raw) return empty;
  if (raw.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.trim())) return empty;
  try {
    const parsed: unknown = JSON.parse(base64ToUtf8(raw.trim()));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const payload = parsed as Record<string, unknown>;
    const version = typeof payload.x402Version === "number" ? payload.x402Version : null;
    const inner = payload.payload as Record<string, unknown> | undefined;
    const auth = inner?.authorization as Record<string, unknown> | undefined;
    const from = typeof auth?.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(auth.from) ? auth.from.toLowerCase() : null;
    const nonce = typeof auth?.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(auth.nonce) ? auth.nonce.toLowerCase() : null;
    return { headerName, raw: raw.trim(), version, payload, from, nonce };
  } catch {
    return empty;
  }
}

/** The exact v2 requirement this server advertises for a quote (same object @x402/core emits in the 402). */
export function v2Requirement(quote: StoredQuote): Record<string, unknown> {
  return {
    scheme: "exact",
    network: NETWORK_V2,
    amount: quote.amount,
    asset: BASE_USDC,
    payTo: quote.pay_to,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { ...USDC_EXTRA },
  };
}

const sortedJson = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(sortedJson).join(",")}]`
      : `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`).join(",")}}`;

/**
 * Tolerant match. @x402/core matches the client's echoed `accepted` block against our requirement by exact
 * deep-equality, so a client that echoes it with cosmetic differences (address case, dropped/extra keys) would be
 * refused. `accepted` is unsigned metadata: the facilitator verifies the SIGNED authorization against OUR
 * requirement. So when the signed authorization pays exactly our payee and amount on exact/Base, we replace
 * `accepted` with our requirement and report which keys differed (for the spike log).
 */
export function tolerantV2Header(
  decoded: DecodedPayment,
  quote: StoredQuote,
): { header: string; rewritten: boolean; differing: string[] } | null {
  if (!decoded.raw || decoded.version !== 2 || !decoded.payload) return null;
  const accepted = decoded.payload.accepted as Record<string, unknown> | undefined;
  const auth = (decoded.payload.payload as { authorization?: Record<string, unknown> } | undefined)?.authorization;
  const ours = v2Requirement(quote);
  if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) return { header: decoded.raw, rewritten: false, differing: [] };
  const keys = new Set([...Object.keys(accepted), ...Object.keys(ours)]);
  const differing = [...keys].filter((k) => sortedJson(accepted[k]) !== sortedJson(ours[k])).sort();
  if (differing.length === 0) return { header: decoded.raw, rewritten: false, differing };
  const signedMatches =
    accepted.scheme === "exact" &&
    accepted.network === NETWORK_V2 &&
    typeof auth?.to === "string" &&
    auth.to.toLowerCase() === quote.pay_to.toLowerCase() &&
    String(auth?.value) === quote.amount;
  if (!signedMatches) return { header: decoded.raw, rewritten: false, differing };
  return { header: utf8ToBase64(JSON.stringify({ ...decoded.payload, accepted: ours })), rewritten: true, differing };
}
