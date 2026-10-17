import { type Address, getAddress } from "viem";
import * as z from "zod/v4";
import { CAIP2, USDC, USDC_EIP712_NAME, USDC_EIP712_VERSION } from "./constants.js";

// x402 402 parsing (client side) and deterministic 402 emission (server side), §7.
// Wire facts mirrored from @x402/core@2.28.0: v2 carries PaymentRequired ONLY in the base64(JSON) PAYMENT-REQUIRED
// header (UTF-8 → standard base64); v1 carries it ONLY in the JSON body with x402Version 1. A response that mixes
// the two is rejected rather than guessed at. Values (scheme/network/asset/payTo/amount) are NOT judged here:
// they are surfaced verbatim so the caller can reject them with a precise reason.

const MAX_HEADER_CHARS = 64 * 1024;
const MAX_BODY_CHARS = 256 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ATOMIC_RE = /^(0|[1-9][0-9]{0,77})$/;

export type X402ErrorCode =
  | "bad_input"
  | "not_402"
  | "too_large"
  | "bad_header"
  | "bad_body"
  | "mixed_versions"
  | "no_payment_required"
  | "invalid_schema";

export class X402ParseError extends Error {
  override name = "X402ParseError";
  readonly code: X402ErrorCode;
  constructor(code: X402ErrorCode, message: string) {
    super(`x402: ${message}`);
    this.code = code;
  }
}

const Extra = z.record(z.string(), z.unknown()).nullish();
const Atomic = z.string().regex(ATOMIC_RE, "expected an atomic decimal amount");
const NonEmpty = z.string().min(1);
const Timeout = z.number().positive();

// Accepts are loose (unknown keys kept) so the refinements can see, and reject, the other version's amount key;
// that makes `normalizeAccept`'s version detection unambiguous.
const AcceptV2Schema = z
  .looseObject({
    scheme: NonEmpty,
    network: z.string().min(3).regex(/:/, "expected CAIP-2"),
    amount: Atomic,
    asset: NonEmpty,
    payTo: NonEmpty,
    maxTimeoutSeconds: Timeout,
    extra: Extra,
  })
  .refine((a) => !("maxAmountRequired" in a), "v2 requirement must not carry v1 maxAmountRequired");

const AcceptV1Schema = z
  .looseObject({
    scheme: NonEmpty,
    network: NonEmpty,
    maxAmountRequired: Atomic,
    resource: NonEmpty,
    description: z.string(),
    mimeType: z.string().optional(),
    outputSchema: z.record(z.string(), z.unknown()).nullish(),
    payTo: NonEmpty,
    maxTimeoutSeconds: Timeout,
    asset: NonEmpty,
    extra: Extra,
  })
  .refine((a) => !("amount" in a), "v1 requirement must not carry v2 amount");

const ResourceSchema = z.object({
  url: NonEmpty,
  description: z.string().nullish(),
  mimeType: z.string().nullish(),
});

const PaymentRequiredV2Schema = z.object({
  x402Version: z.literal(2),
  error: z.string().nullish(),
  resource: ResourceSchema,
  accepts: z.array(AcceptV2Schema).min(1),
});

const PaymentRequiredV1Schema = z.object({
  x402Version: z.literal(1),
  error: z.string().nullish(),
  accepts: z.array(AcceptV1Schema).min(1),
});

export type AcceptV1 = z.infer<typeof AcceptV1Schema>;
export type AcceptV2 = z.infer<typeof AcceptV2Schema>;
export type Accept = AcceptV1 | AcceptV2;
export type X402Resource = { url: string; description?: string; mimeType?: string };
export type PaymentRequired = { version: 1 | 2; accepts: Accept[]; resource?: X402Resource };
export type HeadersLike = Headers | Record<string, string | readonly string[] | undefined>;
export type PaymentRequiredResponse = { status: number; headers: HeadersLike; bodyText: string };

function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const v: unknown = (headers as Headers).get(name);
    if (v === null || v === undefined) return undefined;
    if (typeof v !== "string") throw new X402ParseError("bad_header", `${name} header is not a string`);
    return v;
  }
  const wanted = name.toLowerCase();
  let found: string | undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== wanted || v === undefined) continue;
    const value = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
    if (typeof value !== "string" || (found !== undefined && found !== value)) {
      throw new X402ParseError("bad_header", `ambiguous ${name} header`);
    }
    found = value;
  }
  return found;
}

function decodeBase64Json(value: string): unknown {
  const v = value.trim();
  if (v.length === 0 || v.length % 4 !== 0 || !BASE64_RE.test(v)) {
    throw new X402ParseError("bad_header", "PAYMENT-REQUIRED is not standard base64");
  }
  try {
    const bin = atob(v);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new X402ParseError("bad_header", "PAYMENT-REQUIRED is not base64(UTF-8 JSON)");
  }
}

function parseBody(bodyText: string): unknown {
  if (bodyText.trim().length === 0) return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;
const isRecord = (v: unknown): v is Record<string, unknown> => isObject(v) && !Array.isArray(v);

function schemaError(version: 1 | 2, error: z.ZodError): X402ParseError {
  const first = error.issues[0];
  const where = first ? first.path.join(".") || "(root)" : "(root)";
  return new X402ParseError("invalid_schema", `invalid v${version} PaymentRequired at ${where}: ${first?.message}`);
}

function parse(res: PaymentRequiredResponse): PaymentRequired {
  if (!isRecord(res) || typeof res.status !== "number" || typeof res.bodyText !== "string" || !isObject(res.headers)) {
    throw new X402ParseError("bad_input", "expected {status, headers, bodyText}");
  }
  if (res.status !== 402) throw new X402ParseError("not_402", `status ${res.status} is not 402`);
  if (res.bodyText.length > MAX_BODY_CHARS) throw new X402ParseError("too_large", "body too large");

  const header = getHeader(res.headers, "PAYMENT-REQUIRED");
  const body = parseBody(res.bodyText);
  const bodyHasX402 = isRecord(body) && ("x402Version" in body || "accepts" in body);

  if (header !== undefined) {
    if (header.length > MAX_HEADER_CHARS) throw new X402ParseError("too_large", "PAYMENT-REQUIRED too large");
    if (bodyHasX402) throw new X402ParseError("mixed_versions", "both PAYMENT-REQUIRED header and x402 body");
    const decoded = decodeBase64Json(header);
    if (!isRecord(decoded) || decoded.x402Version !== 2) {
      throw new X402ParseError("mixed_versions", "PAYMENT-REQUIRED header must carry x402Version 2");
    }
    const r = PaymentRequiredV2Schema.safeParse(decoded);
    if (!r.success) throw schemaError(2, r.error);
    const { url, description, mimeType } = r.data.resource;
    const resource: X402Resource = { url };
    if (description != null) resource.description = description;
    if (mimeType != null) resource.mimeType = mimeType;
    return { version: 2, accepts: r.data.accepts, resource };
  }

  if (!bodyHasX402) throw new X402ParseError("no_payment_required", "no PAYMENT-REQUIRED header and no x402 body");
  if (body.x402Version !== 1) {
    throw new X402ParseError("mixed_versions", "x402 body must carry x402Version 1 (v2 uses the header)");
  }
  const r = PaymentRequiredV1Schema.safeParse(body);
  if (!r.success) throw schemaError(1, r.error);
  const accepts = r.data.accepts;
  const first = accepts[0];
  const shared = first !== undefined && accepts.every((a) => a.resource === first.resource);
  const out: PaymentRequired = { version: 1, accepts };
  if (shared) {
    out.resource = { url: first.resource, description: first.description };
    if (first.mimeType !== undefined) out.resource.mimeType = first.mimeType;
  }
  return out;
}

/**
 * Parse an HTTP 402 into its x402 PaymentRequired (v1 body or v2 header, never both).
 * Throws X402ParseError (and only X402ParseError) on anything malformed or ambiguous.
 */
export function parsePaymentRequired(res: PaymentRequiredResponse): PaymentRequired {
  try {
    return parse(res);
  } catch (err) {
    if (err instanceof X402ParseError) throw err;
    throw new X402ParseError("bad_input", err instanceof Error ? err.message : "unparseable response");
  }
}

/** x402 v1 network names (@x402/evm@2.28.0 EVM_NETWORK_CHAIN_ID_MAP + Solana) → CAIP-2. */
const V1_NETWORKS: Readonly<Record<string, string>> = {
  ethereum: "eip155:1",
  sepolia: "eip155:11155111",
  abstract: "eip155:2741",
  "abstract-testnet": "eip155:11124",
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
  "avalanche-fuji": "eip155:43113",
  avalanche: "eip155:43114",
  iotex: "eip155:4689",
  sei: "eip155:1329",
  "sei-testnet": "eip155:1328",
  polygon: "eip155:137",
  "polygon-amoy": "eip155:80002",
  peaq: "eip155:3338",
  story: "eip155:1514",
  educhain: "eip155:41923",
  "skale-base-sepolia": "eip155:324705682",
  megaeth: "eip155:4326",
  monad: "eip155:143",
  "monad-testnet": "eip155:10143",
  stable: "eip155:988",
  "stable-testnet": "eip155:2201",
  celo: "eip155:42220",
  flare: "eip155:14",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

export type NormalizedAccept = {
  scheme: string;
  /** CAIP-2 when known; an unrecognised v1 name is passed through verbatim (it will never equal CAIP2). */
  network: string;
  amount: string;
  /** Verbatim from the wire (not re-checksummed): compare EVM addresses with viem isAddressEqual. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
};

/** Version-independent view of one accepted requirement (v1 maxAmountRequired → amount, v1 network → CAIP-2). */
export function normalizeAccept(a: Accept): NormalizedAccept {
  const hasV1 = "maxAmountRequired" in a;
  const hasV2 = "amount" in a;
  if (hasV1 === hasV2)
    throw new X402ParseError("invalid_schema", "requirement must have exactly one of amount / maxAmountRequired");
  const amount = hasV1 ? (a as AcceptV1).maxAmountRequired : (a as AcceptV2).amount;
  const network = hasV1 && !a.network.includes(":") ? (V1_NETWORKS[a.network] ?? a.network) : a.network;
  return { scheme: a.scheme, network, amount, asset: a.asset, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds };
}

// ---------- server side ----------

export type PaymentRequiredInput = {
  /** Canonical public resource URL, e.g. `${PUBLIC_BASE}/v1/orders/${quoteId}`. */
  url: string;
  description: string;
  /** Atomic USDC; must equal T.amount. */
  amount: bigint | string;
  /** Escrow address E. Emitted EIP-55 checksummed (x402 matches requirements case-sensitively). */
  payTo: Address;
  mimeType?: string;
  maxTimeoutSeconds?: number;
};

/** A complete 402 response. Byte-identical for identical input: no timestamps, fixed key order. */
export type PaymentRequiredWire = { status: 402; headers: Record<string, string>; body: string };

const PAYMENT_REQUIRED_ERROR = "Payment required";
const DEFAULT_TIMEOUT_S = 300;

function checkInput(i: PaymentRequiredInput) {
  const url = new URL(i.url).toString();
  if (typeof i.description !== "string") throw new TypeError("description must be a string");
  const amount = typeof i.amount === "bigint" ? i.amount.toString() : i.amount;
  if (typeof amount !== "string" || !ATOMIC_RE.test(amount) || BigInt(amount) <= 0n || BigInt(amount) >= 1n << 256n) {
    throw new RangeError("amount must be a positive uint256");
  }
  const maxTimeoutSeconds = i.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_S;
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new RangeError("maxTimeoutSeconds must be a positive integer");
  }
  return { url, amount, payTo: getAddress(i.payTo), mimeType: i.mimeType ?? "application/json", maxTimeoutSeconds };
}

const usdcExtra = () => ({ name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION });

/** Base64 of UTF-8 bytes (same output as @x402/core safeBase64Encode). */
function base64Utf8(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** x402 v2 (default wire): PaymentRequired in the PAYMENT-REQUIRED header, body `{}` (§7). */
export function buildPaymentRequiredV2(input: PaymentRequiredInput): PaymentRequiredWire {
  const c = checkInput(input);
  const paymentRequired = {
    x402Version: 2,
    error: PAYMENT_REQUIRED_ERROR,
    resource: { url: c.url, description: input.description, mimeType: c.mimeType },
    accepts: [
      {
        scheme: "exact",
        network: CAIP2,
        amount: c.amount,
        asset: USDC,
        payTo: c.payTo,
        maxTimeoutSeconds: c.maxTimeoutSeconds,
        extra: usdcExtra(),
      },
    ],
  };
  return {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": base64Utf8(JSON.stringify(paymentRequired)),
      "Cache-Control": "no-store",
    },
    body: "{}",
  };
}

/** x402 v1 fallback (X402_WIRE=v1): JSON body only, network "base", maxAmountRequired (§7). */
export function buildPaymentRequiredV1(input: PaymentRequiredInput): PaymentRequiredWire {
  const c = checkInput(input);
  const paymentRequired = {
    x402Version: 1,
    error: PAYMENT_REQUIRED_ERROR,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: c.amount,
        resource: c.url,
        description: input.description,
        mimeType: c.mimeType,
        payTo: c.payTo,
        maxTimeoutSeconds: c.maxTimeoutSeconds,
        asset: USDC,
        extra: usdcExtra(),
      },
    ],
  };
  return {
    status: 402,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(paymentRequired),
  };
}
