// Random identifiers and small crypto helpers (WebCrypto only, so they run unchanged on Workers and Node 24).

export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const QUOTE_ID_RE = /^q_[1-9A-HJ-NP-Za-km-z]{22}$/;
export const ORDER_ID_RE = /^o_[1-9A-HJ-NP-Za-km-z]{22}$/;

/** 22 uniformly random base58 characters (rejection sampling, no modulo bias). */
export function randomBase58(length = 22): string {
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const b of bytes) {
      if (b < 232) out += BASE58_ALPHABET[b % 58];
      if (out.length === length) break;
    }
  }
  return out;
}

export const newQuoteId = (): string => `q_${randomBase58(22)}`;
export const newOrderId = (): string => `o_${randomBase58(22)}`;

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 8785-style canonical JSON for plain JSON values (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}
