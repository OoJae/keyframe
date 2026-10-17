import { deriveFileKey, deriveKBuyer, deriveKChain } from "@keyframe/protocol";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import type { QuoteRow } from "../db/rows.js";
import { PUBLIC_K_BUYER } from "../quotes/build.js";

// Per-quote key material (frozen §4/§5). K_chain and K_buyer never leave the API; the render worker receives
// only K_file for its own job, which can encrypt that one file but cannot release the escrow (keyHash commits to
// K_chain) or open any other order.

const HKDF_INFO = new TextEncoder().encode("keyframe/kfc1/file");

export async function quoteKeys(kmaster: Uint8Array, q: Pick<QuoteRow, "id" | "delivery">) {
  const kChain = await deriveKChain(kmaster, q.id);
  const kBuyer = q.delivery === "private" ? await deriveKBuyer(kmaster, q.id) : PUBLIC_K_BUYER;
  return { kChain, kBuyer };
}

/** Raw K_file = HKDF-SHA256(K_chain ‖ K_buyer, salt = T.salt, "keyframe/kfc1/file", 32 bytes). */
export async function rawFileKey(kChain: Hex, kBuyer: Hex, salt: Hex): Promise<Hex> {
  const ikm = new Uint8Array(64);
  ikm.set(hexToBytes(kChain), 0);
  ikm.set(hexToBytes(kBuyer), 32);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(hexToBytes(salt)), info: HKDF_INFO },
    base,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/** The decrypting CryptoKey, via the protocol's own derivation (the same code path as the plugin). */
export const fileKey = (kChain: Hex, kBuyer: Hex, salt: Hex): Promise<CryptoKey> => deriveFileKey(kChain, kBuyer, salt);
