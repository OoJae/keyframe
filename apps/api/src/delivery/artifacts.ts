import {
  decryptKfc1Chunk,
  jcs,
  KFC1_CHUNK_PLAINTEXT,
  type Manifest,
  ManifestSchema,
  parseMp4Header,
  type Spec,
  sha256Hex,
} from "@keyframe/protocol";
import type { Hex } from "viem";
import { ASPECT_SIZE, FPS } from "../catalog.js";
import { keys, type StorageAdapter } from "../storage.js";

// Validation of everything the render worker (or the Studio CLI) uploads. Nothing is trusted: the API
// re-hashes every byte, decrypts every chunk with the protocol's own KFC1 code, and checks the MP4 header
// before a quote can turn final (or a Studio delivery can go on-chain).

export const LIMITS = {
  stillBytes: 2 * 1024 * 1024,
  previewBytes: 16 * 1024 * 1024,
  plaintextBytes: 48 * 1024 * 1024,
};
const CHUNK_CIPHERTEXT = KFC1_CHUNK_PLAINTEXT + 16;
const FRAME_MS = Math.ceil(1000 / FPS);
const STUDIO_DURATION_MS: Record<string, [number, number]> = {
  studio_sting: [6000, 10_000],
  studio_spot: [15_000, 20_000],
};

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

export function checkStill(bytes: Uint8Array, contentType: string): Check<"webp" | "png"> {
  if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.stillBytes) return bad("still_size");
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (
    type === "image/webp" &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { ok: true, value: "webp" };
  }
  if (type === "image/png" && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ok: true, value: "png" };
  }
  return bad("still_must_be_webp_or_png");
}

export function checkPreview(bytes: Uint8Array, contentType: string): Check<true> {
  if (bytes.byteLength < 12 || bytes.byteLength > LIMITS.previewBytes) return bad("preview_size");
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "video/mp4") return bad("preview_must_be_video_mp4");
  if (!startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return bad("preview_not_mp4");
  return { ok: true, value: true };
}

/** Media expectations from the spec (Instant: exact frame; Studio: the SKU's duration range). */
function checkMedia(m: Manifest, spec: Spec): string | null {
  const size = ASPECT_SIZE[spec.aspect];
  if (m.media.mime !== "video/mp4") return "media_mime";
  if (m.media.width !== size.width || m.media.height !== size.height) return "media_resolution";
  if (m.media.fps !== FPS) return "media_fps";
  const range = STUDIO_DURATION_MS[spec.format];
  if (range) {
    if (m.media.durationMs < range[0] - FRAME_MS || m.media.durationMs > range[1] + FRAME_MS) return "media_duration";
  } else if (Math.abs(m.media.durationMs - spec.durationS * 1000) > FRAME_MS) {
    return "media_duration";
  }
  return null;
}

export async function checkManifest(
  raw: unknown,
  spec: Spec,
  salt: Hex,
): Promise<Check<{ manifest: Manifest; manifestHash: Hex; canonical: string }>> {
  const r = ManifestSchema.safeParse(raw);
  if (!r.success) return bad(`manifest_invalid: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  const manifest = r.data;
  if (manifest.salt !== salt.toLowerCase()) return bad("manifest_salt_mismatch");
  if (manifest.size > LIMITS.plaintextBytes) return bad("manifest_too_large");
  const media = checkMedia(manifest, spec);
  if (media) return bad(media);
  const canonical = jcs(manifest);
  return { ok: true, value: { manifest, manifestHash: await sha256Hex(canonical), canonical } };
}

export async function checkChunk(
  bytes: Uint8Array,
  i: number,
  m: Manifest,
  key: CryptoKey,
  salt: Hex,
): Promise<Check<{ plaintext: Uint8Array; sha256: Hex }>> {
  if (!Number.isSafeInteger(i) || i < 0 || i >= m.chunks) return bad("chunk_index");
  const last = i === m.chunks - 1;
  const expectedLen = last ? m.size - i * KFC1_CHUNK_PLAINTEXT + 16 : CHUNK_CIPHERTEXT;
  if (bytes.byteLength !== expectedLen) return bad("chunk_length");
  const sha = await sha256Hex(bytes);
  if (sha !== m.ciphertext[i]) return bad("chunk_ciphertext_hash");
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptKfc1Chunk(bytes, i, m.chunks, key, salt);
  } catch {
    return bad("chunk_decrypt");
  }
  if ((await sha256Hex(plaintext)) !== m.plaintext[i]) return bad("chunk_plaintext_hash");
  if (i === 0) {
    const h = parseMp4Header(plaintext);
    if (!h) return bad("mp4_not_faststart");
    if (h.width !== m.media.width || h.height !== m.media.height) return bad("mp4_resolution");
    if (Math.abs(h.durationMs - m.media.durationMs) > FRAME_MS) return bad("mp4_duration");
  }
  return { ok: true, value: { plaintext, sha256: sha } };
}

/** Final self-check from public storage: every chunk present, authentic, and the whole file hashes right. */
export async function verifyStored(
  storage: StorageAdapter,
  m: Manifest,
  manifestHash: Hex,
  key: CryptoKey,
  salt: Hex,
): Promise<Check<true>> {
  const stored = await storage.get(keys.manifest(manifestHash));
  if (!stored || (await sha256Hex(stored.bytes)) !== manifestHash) return bad("stored_manifest_mismatch");
  const whole = new Uint8Array(m.size);
  for (let i = 0; i < m.chunks; i++) {
    const c = await storage.get(keys.chunk(manifestHash, i));
    if (!c) return bad(`chunk_${i}_missing`);
    const r = await checkChunk(c.bytes, i, m, key, salt);
    if (!r.ok) return bad(`chunk_${i}: ${r.error}`);
    whole.set(r.value.plaintext, i * KFC1_CHUNK_PLAINTEXT);
  }
  if ((await sha256Hex(whole)) !== m.plaintextSha256) return bad("plaintext_sha256");
  return { ok: true, value: true };
}
