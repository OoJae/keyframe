import { createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { type Hex, hexToBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decryptKfc1Chunk,
  deriveFileKey,
  encryptKfc1,
  jcs,
  KFC1_CHUNK_PLAINTEXT,
  type Kfc1Encrypted,
  ManifestSchema,
  verifyManifest,
} from "../src/index.js";
import { patternBytes } from "./helpers.js";

// The shared kfc1 vector from docs/design/vectors/terms-v1.input.json.
const K_CHAIN: Hex = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const K_BUYER: Hex = `0x${"00".repeat(32)}`;
const SALT: Hex = "0x6a1f0c2e4b7d9a3c5e8f1b2d4a6c8e0f3b5d7a9c1e2f4b6d8a0c3e5f7b9d1a2c";
const MEDIA = { mime: "video/mp4", width: 1080, height: 1920, durationMs: 6000, fps: 30 };
const SIZE = 2_500_000;
const plaintext = patternBytes(SIZE);
const sha256 = (b: Uint8Array) => `0x${createHash("sha256").update(b).digest("hex")}`;

let enc: Kfc1Encrypted;
let key: CryptoKey;

async function decryptAll(chunks: Uint8Array[], n: number, k: CryptoKey, salt: Hex): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) parts.push(await decryptKfc1Chunk(chunks[i] as Uint8Array, i, n, k, salt));
  return Buffer.concat(parts);
}

const flipBit = (u: Uint8Array, byte: number, bit = 0): Uint8Array => {
  const c = Uint8Array.from(u);
  c[byte] = (c[byte] as number) ^ (1 << bit);
  return c;
};

beforeAll(async () => {
  enc = await encryptKfc1(plaintext, { kChain: K_CHAIN, kBuyer: K_BUYER, salt: SALT, media: MEDIA });
  key = await deriveFileKey(K_CHAIN, K_BUYER, SALT);
});

describe("KFC1 container (§5)", () => {
  it("chunk geometry: 1 MiB ciphertext chunks, short last chunk", () => {
    expect(enc.chunks.map((c) => c.byteLength)).toEqual([1_048_576, 1_048_576, SIZE - 2 * KFC1_CHUNK_PLAINTEXT + 16]);
  });

  it("manifest content and manifestHash = sha256(JCS(manifest))", () => {
    const m = enc.manifest;
    expect(ManifestSchema.parse(m)).toEqual(m);
    expect(m).toMatchObject({
      v: 1,
      alg: "KFC1",
      salt: SALT,
      chunkSize: 1_048_560,
      size: SIZE,
      chunks: 3,
      media: MEDIA,
    });
    expect(m.plaintextSha256).toBe(sha256(plaintext));
    expect(m.ciphertext).toEqual(enc.chunks.map(sha256));
    expect(m.plaintext).toEqual(
      [0, 1, 2].map((i) => sha256(plaintext.subarray(i * KFC1_CHUNK_PLAINTEXT, (i + 1) * KFC1_CHUNK_PLAINTEXT))),
    );
    expect(enc.manifestHash).toBe(sha256(Buffer.from(jcs(m), "utf8")));
  });

  it("is deterministic (counter nonces, no randomness)", async () => {
    const again = await encryptKfc1(plaintext, { kChain: K_CHAIN, kBuyer: K_BUYER, salt: SALT, media: MEDIA });
    expect(again.manifestHash).toBe(enc.manifestHash);
  });

  it("independent node:crypto decryption confirms HKDF params, nonce and AAD layout", () => {
    const ikm = Buffer.concat([hexToBytes(K_CHAIN), hexToBytes(K_BUYER)]);
    const kFile = Buffer.from(hkdfSync("sha256", ikm, hexToBytes(SALT), Buffer.from("keyframe/kfc1/file"), 32));
    const n = enc.chunks.length;
    const out: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const c = enc.chunks[i] as Uint8Array;
      const iv = Buffer.alloc(12);
      iv.writeBigUInt64BE(BigInt(i), 4);
      const aad = Buffer.alloc(52);
      aad.write("KFC1", 0, "utf8");
      Buffer.from(hexToBytes(SALT)).copy(aad, 4);
      aad.writeBigUInt64BE(BigInt(i), 36);
      aad.writeBigUInt64BE(BigInt(n), 44);
      const d = createDecipheriv("aes-256-gcm", kFile, iv);
      d.setAAD(aad);
      d.setAuthTag(Buffer.from(c.subarray(c.byteLength - 16)));
      out.push(Buffer.concat([d.update(c.subarray(0, c.byteLength - 16)), d.final()]));
    }
    expect(Buffer.concat(out).equals(Buffer.from(plaintext))).toBe(true);
  });

  it("round-trips through decryptKfc1Chunk", async () => {
    const pt = await decryptAll(enc.chunks, enc.chunks.length, key, SALT);
    expect(Buffer.from(pt).equals(Buffer.from(plaintext))).toBe(true);
  });

  it("round-trips a tiny file and an exact multiple of the chunk size", async () => {
    for (const size of [1, KFC1_CHUNK_PLAINTEXT, KFC1_CHUNK_PLAINTEXT + 1]) {
      const p = patternBytes(size);
      const e = await encryptKfc1(p, { kChain: K_CHAIN, kBuyer: K_BUYER, salt: SALT, media: MEDIA });
      expect(e.manifest.chunks).toBe(Math.ceil(size / KFC1_CHUNK_PLAINTEXT));
      expect(Buffer.from(await decryptAll(e.chunks, e.chunks.length, key, SALT)).equals(Buffer.from(p))).toBe(true);
    }
  });

  describe("fails closed", () => {
    const n = 3;
    it("1-bit tamper anywhere in a chunk (body or tag)", async () => {
      const c0 = enc.chunks[0] as Uint8Array;
      const c2 = enc.chunks[2] as Uint8Array;
      for (const [c, i, byte] of [
        [c0, 0, 0],
        [c0, 0, 123_456],
        [c0, 0, c0.byteLength - 1],
        [c2, 2, c2.byteLength - 17],
      ] as const) {
        await expect(decryptKfc1Chunk(flipBit(c, byte, 3), i, n, key, SALT)).rejects.toThrow(/authentication/);
      }
    });

    it("chunk reorder / wrong index", async () => {
      await expect(decryptKfc1Chunk(enc.chunks[1] as Uint8Array, 0, n, key, SALT)).rejects.toThrow(/authentication/);
      await expect(decryptKfc1Chunk(enc.chunks[0] as Uint8Array, 1, n, key, SALT)).rejects.toThrow(/authentication/);
    });

    it("truncation: dropped final chunk, wrong n, shortened chunk", async () => {
      // An attacker presenting chunk 1 as the last of n=2 (file cut short) fails: n is bound in the AAD.
      await expect(decryptKfc1Chunk(enc.chunks[1] as Uint8Array, 1, 2, key, SALT)).rejects.toThrow(/authentication/);
      await expect(decryptKfc1Chunk(enc.chunks[2] as Uint8Array, 2, 4, key, SALT)).rejects.toThrow();
      const last = enc.chunks[2] as Uint8Array;
      await expect(decryptKfc1Chunk(last.subarray(0, last.byteLength - 1), 2, n, key, SALT)).rejects.toThrow(
        /authentication/,
      );
      await expect(decryptKfc1Chunk((enc.chunks[0] as Uint8Array).subarray(1), 0, n, key, SALT)).rejects.toThrow(
        /length/,
      );
      await expect(decryptKfc1Chunk(new Uint8Array(16), 2, n, key, SALT)).rejects.toThrow(/length/);
    });

    it("wrong K_buyer, K_chain or salt", async () => {
      const c0 = enc.chunks[0] as Uint8Array;
      const wrongBuyer = await deriveFileKey(K_CHAIN, `0x${"00".repeat(31)}01`, SALT);
      const wrongChain = await deriveFileKey(`0x${"11".repeat(32)}`, K_BUYER, SALT);
      await expect(decryptKfc1Chunk(c0, 0, n, wrongBuyer, SALT)).rejects.toThrow(/authentication/);
      await expect(decryptKfc1Chunk(c0, 0, n, wrongChain, SALT)).rejects.toThrow(/authentication/);
      await expect(decryptKfc1Chunk(c0, 0, n, key, `0x${"00".repeat(32)}`)).rejects.toThrow(/authentication/);
    });

    it("bad index arguments", async () => {
      const c0 = enc.chunks[0] as Uint8Array;
      for (const [i, nn] of [
        [-1, 3],
        [3, 3],
        [0, 0],
        [0.5, 3],
      ] as const) {
        await expect(decryptKfc1Chunk(c0, i, nn, key, SALT)).rejects.toThrow(/KFC1/);
      }
    });
  });

  it("key derivation input validation", async () => {
    await expect(deriveFileKey("0x1234", K_BUYER, SALT)).rejects.toThrow(/kChain/);
    await expect(
      encryptKfc1(new Uint8Array(0), { kChain: K_CHAIN, kBuyer: K_BUYER, salt: SALT, media: MEDIA }),
    ).rejects.toThrow(/empty/);
    await expect(
      encryptKfc1(plaintext.subarray(0, 10), {
        kChain: K_CHAIN,
        kBuyer: K_BUYER,
        salt: SALT,
        media: { ...MEDIA, fps: 29.97 },
      }),
    ).rejects.toThrow();
  });
});

describe("verifyManifest", () => {
  it("accepts the genuine manifest, from an object or a JSON round trip, any hash case", async () => {
    expect(await verifyManifest(enc.manifest, enc.manifestHash)).toBe(true);
    expect(await verifyManifest(JSON.parse(JSON.stringify(enc.manifest)), enc.manifestHash)).toBe(true);
    expect(await verifyManifest(enc.manifest, enc.manifestHash.toUpperCase().replace("0X", "0x") as Hex)).toBe(true);
  });

  it("rejects any change, malformed manifests and malformed hashes", async () => {
    const m = enc.manifest;
    const c0 = m.ciphertext[0] as string;
    const tampered = [
      { ...m, size: m.size - 1 },
      { ...m, media: { ...m.media, durationMs: 6001 } },
      { ...m, ciphertext: [`${c0.slice(0, -1)}${c0.endsWith("0") ? "1" : "0"}`, ...m.ciphertext.slice(1)] },
      { ...m, ciphertext: [...m.ciphertext].reverse() },
      { ...m, extra: true },
      { ...m, chunks: 2, ciphertext: m.ciphertext.slice(0, 2), plaintext: m.plaintext.slice(0, 2) },
      { ...m, salt: m.salt.toUpperCase() },
      null,
      "manifest",
    ];
    for (const t of tampered) expect(await verifyManifest(t, enc.manifestHash)).toBe(false);
    expect(await verifyManifest(m, "0x1234")).toBe(false);
    expect(await verifyManifest(m, `0x${"00".repeat(32)}`)).toBe(false);
  });
});
