import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bytesToHex, type Hex } from "viem";
import { rawFileKey, sealFile } from "./kfc1.ts";
import {
  decryptKfc1Chunk,
  deriveFileKey,
  jcs,
  type Kfc1Media,
  type Mp4Header,
  newQuoteId,
  parseMp4Header,
  saltOf,
  sha256Hex,
  verifyManifest,
} from "./protocol/index.ts";

// LOCAL VERIFICATION ONLY (cli.ts `render --seal`). In service mode the API hands each job its K_file and the
// worker seals with it (kfc1.ts). Here, throwaway K_chain/K_buyer are generated in memory, K_file is derived
// from them exactly as the API derives it, and the master is sealed with the same sealFile() the service uses.
// The container is then read back from disk and decrypted through the plugin's own path
// (deriveFileKey(K_chain, K_buyer, salt) + decryptKfc1Chunk), which proves the plaintext is byte-identical. The keys
// are used once and never written or logged. The on-disk layout matches §5 storage:
// c/{manifestHash}/manifest.json + {i}.bin.

export type SealReport = {
  quoteId: string;
  salt: Hex;
  delivery: "public" | "private";
  manifestHash: Hex;
  manifestPath: string;
  chunks: number;
  size: number;
  plaintextSha256: Hex;
  decryptedSha256: Hex;
  roundTrip: boolean;
  manifestVerified: boolean;
  chunk0Header: Mp4Header | null;
  encryptMs: number;
  decryptMs: number;
};

export async function sealRoundTrip(
  masterPath: string,
  media: Kfc1Media,
  outDir: string,
  opts: { quoteId?: string; delivery?: "public" | "private" } = {},
): Promise<SealReport> {
  const quoteId = opts.quoteId ?? newQuoteId();
  const delivery = opts.delivery ?? "public";
  const salt = saltOf(quoteId);
  // §4: K_buyer is 32 zero bytes for public delivery.
  const kChain = bytesToHex(randomBytes(32));
  const kBuyer = delivery === "private" ? bytesToHex(randomBytes(32)) : bytesToHex(new Uint8Array(32));

  const plaintextSha256 = await sha256Hex(new Uint8Array(await readFile(masterPath)));

  let t0 = performance.now();
  const sealed = await sealFile(masterPath, await rawFileKey(kChain, kBuyer, salt), salt, media);
  const dir = path.join(outDir, "c", sealed.manifestHash);
  await mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  // Stored in canonical form, so sha256(manifest.json) is the manifestHash itself.
  await writeFile(manifestPath, jcs(sealed.manifest));
  for (const [i, chunk] of sealed.chunks.entries()) await writeFile(path.join(dir, `${i}.bin`), chunk);
  const encryptMs = Math.round(performance.now() - t0);

  // Decrypt from disk, as a buyer would from public storage.
  t0 = performance.now();
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as typeof sealed.manifest;
  const manifestVerified =
    (await verifyManifest(manifest, sealed.manifestHash)) && (await sha256Hex(manifestRaw)) === sealed.manifestHash;
  const key = await deriveFileKey(kChain, kBuyer, manifest.salt);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < manifest.chunks; i++) {
    const ct = new Uint8Array(await readFile(path.join(dir, `${i}.bin`)));
    if ((await sha256Hex(ct)) !== manifest.ciphertext[i]) throw new Error(`chunk ${i}: ciphertext hash mismatch`);
    const pt = await decryptKfc1Chunk(ct, i, manifest.chunks, key, manifest.salt);
    if ((await sha256Hex(pt)) !== manifest.plaintext[i]) throw new Error(`chunk ${i}: plaintext hash mismatch`);
    parts.push(pt);
  }
  const decrypted = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    decrypted.set(p, off);
    off += p.byteLength;
  }
  const decryptedSha256 = await sha256Hex(decrypted);
  const decryptMs = Math.round(performance.now() - t0);

  return {
    quoteId,
    salt,
    delivery,
    manifestHash: sealed.manifestHash,
    manifestPath,
    chunks: manifest.chunks,
    size: manifest.size,
    plaintextSha256,
    decryptedSha256,
    roundTrip: decryptedSha256 === plaintextSha256 && manifest.plaintextSha256 === plaintextSha256,
    manifestVerified,
    chunk0Header: parts[0] ? parseMp4Header(parts[0]) : null,
    encryptMs,
    decryptMs,
  };
}
