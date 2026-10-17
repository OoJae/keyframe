import { type Hex, keccak256 } from "viem";
import { utf8 } from "./bytes.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ID_CHARS = 22;
// Largest multiple of 58 below 256: bytes >= 232 are rejected so every character is uniform (~5.86 bits each).
const ACCEPT_BELOW = 232;

function randomBase58(len: number): string {
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < ACCEPT_BELOW) out += BASE58[b % 58];
      if (out.length === len) break;
    }
  }
  return out;
}

/** "q_" + 22 uniform base58 characters (~128.9 bits). */
export const newQuoteId = (): string => `q_${randomBase58(ID_CHARS)}`;

/** "o_" + 22 uniform base58 characters (~128.9 bits). */
export const newOrderId = (): string => `o_${randomBase58(ID_CHARS)}`;

/** T.salt = keccak256(utf8(quote_id)). */
export function saltOf(quoteId: string): Hex {
  if (typeof quoteId !== "string" || quoteId.length === 0) throw new TypeError("quoteId must be a non-empty string");
  return keccak256(utf8(quoteId));
}
