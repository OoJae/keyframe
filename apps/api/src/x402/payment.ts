import { getAddress, type Hex } from "viem";

// Decoding of the client's payment header: v2 `PAYMENT-SIGNATURE` or v1 `X-PAYMENT`, both base64(JSON) of a
// PaymentPayload carrying an EIP-3009 authorization. Only shape is checked here; signatures are verified by the
// x402 exact verifier.

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface DecodedPayment {
  version: 1 | 2;
  /** Header value exactly as received (trimmed). */
  raw: string;
  payload: Record<string, unknown>;
  authorization: Authorization;
  signature: Hex;
  /** Lowercase payer and nonce: the exactly-once key. */
  fromLc: string;
  nonceLc: string;
}

export type PaymentHeader =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; payment: DecodedPayment };

const MAX_HEADER = 16 * 1024;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x(?:[0-9a-fA-F]{2})+$/;

export function base64ToUtf8(value: string): string {
  const bin = atob(value);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export function utf8ToBase64(value: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(value)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readPaymentHeader(headers: Headers): PaymentHeader {
  const v2 = headers.get("payment-signature");
  const v1 = headers.get("x-payment");
  if (v2 === null && v1 === null) return { kind: "none" };
  if (v2 !== null && v1 !== null) return { kind: "invalid", reason: "both PAYMENT-SIGNATURE and X-PAYMENT present" };
  const raw = (v2 ?? v1 ?? "").trim();
  const headerVersion = v2 !== null ? 2 : 1;
  if (raw.length === 0 || raw.length > MAX_HEADER || !B64.test(raw)) {
    return { kind: "invalid", reason: "payment header is not base64" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(base64ToUtf8(raw));
  } catch {
    return { kind: "invalid", reason: "payment header is not base64(JSON)" };
  }
  if (!isRecord(payload) || payload.x402Version !== headerVersion) {
    return { kind: "invalid", reason: `payment header must carry x402Version ${headerVersion}` };
  }
  const inner = payload.payload;
  if (!isRecord(inner) || !isRecord(inner.authorization) || typeof inner.signature !== "string") {
    return { kind: "invalid", reason: "only exact EIP-3009 authorizations are accepted" };
  }
  const a = inner.authorization;
  const ok =
    typeof a.from === "string" &&
    ADDRESS.test(a.from) &&
    typeof a.to === "string" &&
    ADDRESS.test(a.to) &&
    typeof a.value === "string" &&
    UINT.test(a.value) &&
    typeof a.validAfter === "string" &&
    UINT.test(a.validAfter) &&
    typeof a.validBefore === "string" &&
    UINT.test(a.validBefore) &&
    typeof a.nonce === "string" &&
    BYTES32.test(a.nonce) &&
    SIG.test(inner.signature);
  if (!ok) return { kind: "invalid", reason: "malformed EIP-3009 authorization" };
  const authorization = a as unknown as Authorization;
  return {
    kind: "ok",
    payment: {
      version: headerVersion,
      raw,
      payload,
      authorization,
      signature: inner.signature as Hex,
      fromLc: getAddress(authorization.from).toLowerCase(),
      nonceLc: authorization.nonce.toLowerCase(),
    },
  };
}
