// Per-quote payee derivation: BIP-39 mnemonic -> BIP-32 m/44'/60'/0'/0/{index}.
//
// Equivalent to viem's mnemonicToAccount(mnemonic, { addressIndex }) (same seed, same path), but the
// 2048-round PBKDF2 runs through WebCrypto (native) instead of pure JS so a Workers request stays within
// its CPU budget. The account-level node is cached per isolate. Only the public address leaves this module.

import { getAddress } from "viem";
import { HDKey, privateKeyToAddress } from "viem/accounts";

const VALID_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
let cache: { fingerprint: string; node: HDKey } | null = null;

/** Collapse whitespace the same way the sweep tool does, so both sides derive the same seed. */
export function normalizeMnemonic(raw: string): string {
  const normalized = raw.normalize("NFKD").trim().split(/\s+/).join(" ");
  if (!VALID_WORD_COUNTS.has(normalized.split(" ").length)) {
    throw new Error("SPIKE_MNEMONIC must contain 12, 15, 18, 21 or 24 words");
  }
  return normalized;
}

async function bip39Seed(mnemonic: string, passphrase = ""): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(mnemonic), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-512", salt: enc.encode(`mnemonic${passphrase.normalize("NFKD")}`), iterations: 2048 },
    key,
    512,
  );
  return new Uint8Array(bits);
}

async function accountNode(rawMnemonic: string): Promise<HDKey> {
  const mnemonic = normalizeMnemonic(rawMnemonic);
  // Cache key: a hash of the mnemonic (never stored or logged), so a rotated secret invalidates the cache.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mnemonic)));
  const fingerprint = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (cache && cache.fingerprint === fingerprint) return cache.node;
  const root = HDKey.fromMasterSeed(await bip39Seed(mnemonic));
  const node = root.derive("m/44'/60'/0'/0");
  root.wipePrivateData();
  cache = { fingerprint, node };
  return node;
}

/** EIP-55 checksummed address of HD index `index`. */
export async function deriveSpikePayee(rawMnemonic: string, index: number): Promise<`0x${string}`> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error("index out of range");
  const child = (await accountNode(rawMnemonic)).deriveChild(index);
  if (!child.privateKey) throw new Error("derivation failed");
  const hex = `0x${[...child.privateKey].map((b) => b.toString(16).padStart(2, "0")).join("")}` as const;
  const address = getAddress(privateKeyToAddress(hex));
  child.wipePrivateData();
  return address;
}
