import { type Hex, keccak256 } from "viem";
import { bufferSource, bytes32, toHex, utf8 } from "./bytes.js";

// §4. K_chain is revealed on-chain by `release`; K_buyer exists only for private delivery (public => 32 zero bytes,
// which callers use directly). KMASTER never leaves the API environment.

const MIN_KMASTER_BYTES = 32;

async function hmacSha256(key: Uint8Array, message: string): Promise<Hex> {
  if (!(key instanceof Uint8Array) || key.byteLength < MIN_KMASTER_BYTES) {
    throw new TypeError(`KMASTER must be at least ${MIN_KMASTER_BYTES} bytes`);
  }
  const k = await crypto.subtle.importKey("raw", bufferSource(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8(message))));
}

function checkQuoteId(quoteId: string): void {
  if (typeof quoteId !== "string" || quoteId.length === 0) throw new TypeError("quoteId must be a non-empty string");
}

/** K_chain = HMAC-SHA256(KMASTER, utf8("kf/kchain/v1/" ‖ quote_id)). */
export async function deriveKChain(kmaster: Uint8Array, quoteId: string): Promise<Hex> {
  checkQuoteId(quoteId);
  return hmacSha256(kmaster, `kf/kchain/v1/${quoteId}`);
}

/** K_buyer = HMAC-SHA256(KMASTER, utf8("kf/kbuyer/v1/" ‖ quote_id)) for private delivery. */
export async function deriveKBuyer(kmaster: Uint8Array, quoteId: string): Promise<Hex> {
  checkQuoteId(quoteId);
  return hmacSha256(kmaster, `kf/kbuyer/v1/${quoteId}`);
}

/** keyHash = keccak256(K_chain) over the 32 raw bytes. */
export function keyHashOf(kChain: Hex): Hex {
  return keccak256(bytes32(kChain, "kChain"));
}
