import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { bytesToHex, type Hex } from "viem";
import { WORKER_ROOT } from "../src/config.ts";
import { importFileKey, rawFileKey, sealWithFileKey } from "../src/kfc1.ts";
import { decryptKfc1Chunk, deriveFileKey, encryptKfc1, saltOf } from "../src/protocol/index.ts";

const media = { mime: "video/mp4", width: 1080, height: 1920, durationMs: 2000, fps: 30 };
const hex32 = (): Hex => bytesToHex(randomBytes(32));
// A real faststart MP4 (the protocol package's ffmpeg fixture), so the chunk-0 header check has something to read.
const fixture = new Uint8Array(
  await readFile(path.resolve(WORKER_ROOT, "../../packages/protocol/test/fixtures/faststart.m4v")),
);

describe("sealWithFileKey", () => {
  it("is byte-identical to @keyframe/protocol encryptKfc1 for the same K_chain/K_buyer/salt", async () => {
    for (const size of [fixture.byteLength, 1_048_560, 1_048_561, 2_500_000]) {
      const plaintext = new Uint8Array(size);
      plaintext.set(fixture.subarray(0, Math.min(size, fixture.byteLength)));
      for (let i = fixture.byteLength; i < size; i++) plaintext[i] = (i * 31) & 0xff;
      const kChain = hex32();
      const kBuyer = size % 2 ? hex32() : bytesToHex(new Uint8Array(32));
      const salt = saltOf("q_1111111111111111111111");
      const ref = await encryptKfc1(plaintext, { kChain, kBuyer, salt, media });
      const kFile = await rawFileKey(kChain, kBuyer, salt);
      // Independent HKDF (node:crypto) agrees with the WebCrypto derivation.
      const ikm = Buffer.concat([Buffer.from(kChain.slice(2), "hex"), Buffer.from(kBuyer.slice(2), "hex")]);
      assert.equal(
        kFile,
        `0x${Buffer.from(hkdfSync("sha256", ikm, Buffer.from(salt.slice(2), "hex"), "keyframe/kfc1/file", 32)).toString("hex")}`,
      );
      const mine = await sealWithFileKey(plaintext, kFile, salt, media);
      assert.equal(mine.manifestHash, ref.manifestHash, `size ${size}`);
      assert.deepEqual(mine.manifest, ref.manifest);
      assert.equal(mine.chunks.length, ref.chunks.length);
      for (const [i, c] of mine.chunks.entries()) assert.deepEqual(c, ref.chunks[i]);
      // And the plugin's derivation (deriveFileKey from K_chain/K_buyer) decrypts it.
      const pluginKey = await deriveFileKey(kChain, kBuyer, salt);
      const pt0 = await decryptKfc1Chunk(mine.chunks[0] as Uint8Array, 0, mine.chunks.length, pluginKey, salt);
      assert.deepEqual(pt0, plaintext.subarray(0, pt0.byteLength));
    }
  });

  it("refuses a master whose first chunk has no MP4 header, and bad key material", async () => {
    const salt = saltOf("q_1111111111111111111111");
    await assert.rejects(sealWithFileKey(new Uint8Array(5000).fill(1), hex32(), salt, media), /faststart/);
    await assert.rejects(sealWithFileKey(fixture, "0x1234" as Hex, salt, media), /32 bytes/);
    await assert.rejects(sealWithFileKey(new Uint8Array(0), hex32(), salt, media), /empty/);
  });

  it("a wrong key cannot decrypt", async () => {
    const salt = saltOf("q_1111111111111111111111");
    const sealed = await sealWithFileKey(fixture, hex32(), salt, media);
    const other = await importFileKey(hex32());
    await assert.rejects(
      decryptKfc1Chunk(sealed.chunks[0] as Uint8Array, 0, sealed.chunks.length, other, salt),
      /authentication/,
    );
  });
});
