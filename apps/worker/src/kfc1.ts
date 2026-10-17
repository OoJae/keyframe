import { readFile } from "node:fs/promises";
import { type Hex, hexToBytes } from "viem";
import {
  decryptKfc1Chunk,
  jcs,
  KFC1_CHUNK_PLAINTEXT,
  type Kfc1Media,
  type Manifest,
  ManifestSchema,
  parseMp4Header,
  sha256Hex,
  verifyManifest,
} from "./protocol/index.ts";

// KFC1 sealing with a raw per-file key (frozen-interfaces §5). The API derives
// K_file = HKDF-SHA256(K_chain ‖ K_buyer, salt = T.salt, "keyframe/kfc1/file") and hands the worker only that key
// for its own job. KMASTER, K_chain and K_buyer never reach the worker, and K_file cannot be turned back into
// K_chain, so it adds no capability beyond the plaintext the worker rendered anyway (ADR-017).
//
// @keyframe/protocol's encryptKfc1 takes K_chain/K_buyer, which the worker must not hold, so the per-chunk
// encryption is the only part done here. Everything else is the protocol's own code: ManifestSchema, JCS,
// sha256Hex, and decryptKfc1Chunk + verifyManifest to check every chunk before anything is uploaded.
// test/kfc1.test.ts proves the output is byte-identical to encryptKfc1 for the same keys.

const MAGIC = new TextEncoder().encode("KFC1");

function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function bytes32(h: Hex, what: string): Uint8Array<ArrayBuffer> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new TypeError(`${what} must be 32 bytes of hex`);
  return new Uint8Array(hexToBytes(h));
}

/** The AES-256-GCM key for a raw K_file, usable with the protocol's decryptKfc1Chunk. */
export function importFileKey(kFile: Hex): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes32(kFile, "k_file"), { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export type Sealed = { manifest: Manifest; manifestHash: Hex; chunks: Uint8Array[] };

/** Encrypt `plaintext` into KFC1 chunks + manifest, then decrypt every chunk again before returning. */
export async function sealWithFileKey(plaintext: Uint8Array, kFile: Hex, salt: Hex, media: Kfc1Media): Promise<Sealed> {
  if (plaintext.byteLength === 0) throw new Error("KFC1: plaintext is empty");
  const saltBytes = bytes32(salt, "salt");
  const key = await importFileKey(kFile);
  const size = plaintext.byteLength;
  const n = Math.ceil(size / KFC1_CHUNK_PLAINTEXT);
  const chunks: Uint8Array[] = [];
  const ciphertext: Hex[] = [];
  const plain: Hex[] = [];
  for (let i = 0; i < n; i++) {
    const pt = plaintext.subarray(i * KFC1_CHUNK_PLAINTEXT, Math.min((i + 1) * KFC1_CHUNK_PLAINTEXT, size));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: concat(new Uint8Array(4), u64be(i)),
          additionalData: concat(MAGIC, saltBytes, u64be(i), u64be(n)),
          tagLength: 128,
        },
        key,
        concat(pt),
      ),
    );
    chunks.push(ct);
    ciphertext.push(await sha256Hex(ct));
    plain.push(await sha256Hex(pt));
  }
  const manifest = ManifestSchema.parse({
    v: 1,
    alg: "KFC1",
    salt: salt.toLowerCase(),
    chunkSize: KFC1_CHUNK_PLAINTEXT,
    size,
    chunks: n,
    plaintextSha256: await sha256Hex(plaintext),
    ciphertext,
    plaintext: plain,
    media,
  });
  const manifestHash = await sha256Hex(jcs(manifest));

  // Self-check with the protocol's decryptor: the same code the API and the plugin run.
  if (!(await verifyManifest(manifest, manifestHash))) throw new Error("KFC1: manifest does not verify");
  for (const [i, ct] of chunks.entries()) {
    const pt = await decryptKfc1Chunk(ct, i, n, key, manifest.salt);
    if ((await sha256Hex(pt)) !== manifest.plaintext[i]) throw new Error(`KFC1: chunk ${i} does not round-trip`);
    if (i === 0 && !parseMp4Header(pt)) throw new Error("KFC1: chunk 0 has no readable MP4 header (not faststart)");
  }
  return { manifest, manifestHash, chunks };
}

export async function sealFile(file: string, kFile: Hex, salt: Hex, media: Kfc1Media): Promise<Sealed> {
  return sealWithFileKey(new Uint8Array(await readFile(file)), kFile, salt, media);
}

/** Raw K_file from K_chain/K_buyer/salt (HKDF-SHA256, info "keyframe/kfc1/file"). Local CLI and tests only. */
export async function rawFileKey(kChain: Hex, kBuyer: Hex, salt: Hex): Promise<Hex> {
  const base = await crypto.subtle.importKey(
    "raw",
    concat(bytes32(kChain, "kChain"), bytes32(kBuyer, "kBuyer")),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes32(salt, "salt"),
      info: new TextEncoder().encode("keyframe/kfc1/file"),
    },
    base,
    256,
  );
  return `0x${Buffer.from(bits).toString("hex")}`;
}
