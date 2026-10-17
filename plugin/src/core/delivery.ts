// Delivery proof (frozen-interfaces.md §5): fetch the public KFC1 manifest and chunks, check every hash, decrypt
// with WebCrypto using the key read from Base, and read the MP4 header of chunk 0. Locations are untrusted; only
// hashes count. Chunks are sampled adaptively (first, last, then the rest) while the call's budget allows.

import type { Hex } from "viem";
import {
  decryptKfc1Chunk,
  deriveFileKey,
  type Manifest,
  ManifestSchema,
  type Mp4Header,
  parseMp4Header,
  type Spec,
  sha256Hex,
  verifyManifest,
} from "../protocol/index.js";
import { type Check, fail, pass, skip, warn } from "./checks.js";
import type { Config } from "./config.js";
import { type Budget, describeNetError, fetchBounded, NetError, parseJson } from "./net.js";

const MANIFEST_CAP_MS = 3_000;
const CHUNK_CAP_MS = 4_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 1_048_576;
const MAX_CHUNKS = 64;
/** Stop starting new chunk downloads below this much remaining budget. */
const CHUNK_RESERVE_MS = 1_500;
const DURATION_TOLERANCE_MS = 100;

const ASPECT_SIZE: Record<string, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "16:9": [1920, 1080],
};

export const manifestUrl = (cfg: Config, mh: Hex): string => `${cfg.filesBase}/c/${mh}/manifest.json`;

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;

/** An IPFS mirror CID published by the backend (loose field), if well-formed. */
export function ipfsCidOf(...records: unknown[]): string | null {
  for (const r of records) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as { ipfs_cid?: unknown; content?: { ipfs_cid?: unknown } };
    for (const c of [o.ipfs_cid, o.content?.ipfs_cid]) if (typeof c === "string" && CID_RE.test(c)) return c;
  }
  return null;
}

/**
 * Where the ciphertext may live (§5): {FILES_BASE}/c/{manifestHash}/ first, then the optional IPFS mirror, a UnixFS
 * directory {manifest.json, 0.bin, 1.bin, …} at {KEYFRAME_IPFS_GATEWAY}/ipfs/{cid}/. Locations are untrusted.
 */
export function sourcesOf(cfg: Config, mh: Hex, cid: string | null): string[] {
  const out = [`${cfg.filesBase}/c/${mh}`];
  if (cfg.ipfsGateway && cid) out.push(`${cfg.ipfsGateway}/ipfs/${cid}`);
  return out;
}

export type DeliveryResult = {
  checks: Check[];
  manifest: Manifest | null;
  chunksVerified: number;
  media: Mp4Header | null;
  complete: boolean;
};

export async function fetchManifest(
  cfg: Config,
  budget: Budget,
  mh: Hex,
  sources: string[] = sourcesOf(cfg, mh, null),
): Promise<{ manifest: Manifest | null; check: Check }> {
  const id = "manifest";
  let why = "could not be downloaded";
  for (const base of sources) {
    let res: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      res = await fetchBounded(`${base}/manifest.json`, { headers: { accept: "application/json" } }, budget, {
        capMs: MANIFEST_CAP_MS,
        maxBytes: MAX_MANIFEST_BYTES,
      });
    } catch (error) {
      if (!(error instanceof NetError)) throw error;
      why = describeNetError(error);
      continue;
    }
    if (res.status !== 200) {
      why = `returned HTTP ${res.status}`;
      continue;
    }
    const json = parseJson(res.bytes);
    if (!(await verifyManifest(json, mh))) {
      return {
        manifest: null,
        check: fail(id, "the downloaded manifest does not hash to the manifest hash published on Base"),
      };
    }
    const manifest = ManifestSchema.parse(json);
    return {
      manifest,
      check: pass(
        id,
        `manifest matches the hash on Base: ${manifest.chunks} encrypted chunk(s), ${manifest.size} bytes, ${manifest.media.width}x${manifest.media.height}`,
      ),
    };
  }
  return { manifest: null, check: skip(id, `the public manifest ${why}`) };
}

function sampleOrder(n: number, max: number): number[] {
  const order = n === 1 ? [0] : [0, n - 1];
  for (let i = 1; i < n - 1; i++) order.push(i);
  return order.slice(0, Math.min(max, MAX_CHUNKS));
}

type ChunkOutcome = { i: number; ok: true; plaintext: Uint8Array } | { i: number; ok: false; check: Check };

async function download(sources: string[], i: number, budget: Budget): Promise<Uint8Array | null> {
  for (const base of sources) {
    try {
      const res = await fetchBounded(`${base}/${i}.bin`, { headers: { accept: "application/octet-stream" } }, budget, {
        capMs: CHUNK_CAP_MS,
        maxBytes: MAX_CHUNK_BYTES,
      });
      if (res.status === 200) return res.bytes;
    } catch (error) {
      if (!(error instanceof NetError)) throw error;
    }
  }
  return null;
}

async function checkChunk(
  sources: string[],
  budget: Budget,
  m: Manifest,
  key: CryptoKey,
  i: number,
): Promise<ChunkOutcome | null> {
  const bytes = await download(sources, i, budget);
  if (!bytes) return null;
  if ((await sha256Hex(bytes)) !== m.ciphertext[i]) {
    return {
      i,
      ok: false,
      check: fail("chunk_hashes", `encrypted chunk ${i} does not match its hash in the manifest`),
    };
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptKfc1Chunk(bytes, i, m.chunks, key, m.salt as Hex);
  } catch {
    return { i, ok: false, check: fail("decrypts", `chunk ${i} does not decrypt with the published key`) };
  }
  if ((await sha256Hex(plaintext)) !== m.plaintext[i]) {
    return { i, ok: false, check: fail("chunk_hashes", `decrypted chunk ${i} does not match its plaintext hash`) };
  }
  return { i, ok: true, plaintext };
}

export async function verifyChunks(
  sources: string[],
  budget: Budget,
  m: Manifest,
  kChain: Hex,
  kBuyer: Hex,
  opts: { maxChunks: number; spec: Spec | null; privateHint: boolean },
): Promise<DeliveryResult> {
  const checks: Check[] = [];
  const key = await deriveFileKey(kChain, kBuyer, m.salt as Hex);
  const plan = sampleOrder(m.chunks, opts.maxChunks);
  const plain = new Map<number, Uint8Array>();
  let firstFailure: Check | null = null;
  for (let k = 0; k < plan.length && !firstFailure; k += 2) {
    if (budget.remaining() < CHUNK_RESERVE_MS + 500) break;
    const pair = plan.slice(k, k + 2);
    const results = await Promise.all(pair.map((i) => checkChunk(sources, budget, m, key, i)));
    for (const r of results) {
      if (!r) continue;
      if (r.ok) plain.set(r.i, r.plaintext);
      else firstFailure ??= r.check;
    }
    if (results.every((r) => r === null)) break;
  }

  if (firstFailure) {
    if (firstFailure.id === "decrypts" && opts.privateHint) {
      checks.push(
        fail(
          "decrypts",
          `${firstFailure.detail}. This looks like a private order: pass k_buyer (from the paid response or keyframe_orders)`,
        ),
      );
    } else {
      checks.push(firstFailure);
    }
  } else if (plain.size === 0) {
    checks.push(skip("decrypts", "no encrypted chunk could be downloaded within this call's time budget"));
  } else {
    checks.push(
      pass(
        "decrypts",
        `${plain.size} of ${m.chunks} encrypted chunk(s) downloaded, hash-checked and decrypted here with the key from Base`,
      ),
    );
  }

  const complete = !firstFailure && plain.size === m.chunks;
  if (complete) {
    const whole = new Uint8Array(m.size);
    let off = 0;
    for (let i = 0; i < m.chunks; i++) {
      const p = plain.get(i) as Uint8Array;
      whole.set(p, off);
      off += p.byteLength;
    }
    checks.push(
      off === m.size && (await sha256Hex(whole)) === m.plaintextSha256
        ? pass(
            "file_fingerprint",
            `the whole decrypted file (${m.size} bytes) matches its sha256 fingerprint ${m.plaintextSha256.slice(0, 18)}…`,
          )
        : fail("file_fingerprint", "the reassembled file does not match its sha256 fingerprint"),
    );
  } else if (!firstFailure) {
    checks.push(
      skip(
        "file_fingerprint",
        `only ${plain.size} of ${m.chunks} chunks fit in this call; call again (max_chunks) to check the rest`,
      ),
    );
  }

  let media: Mp4Header | null = null;
  const first = plain.get(0);
  if (first && !firstFailure) {
    media = parseMp4Header(first);
    if (!media) {
      checks.push(
        skip("video_header", "the MP4 header is not in the first chunk, so length and resolution are unverifiable"),
      );
    } else {
      const mm = m.media;
      const sizeOk = media.width === mm.width && media.height === mm.height;
      const durOk = Math.abs(media.durationMs - mm.durationMs) <= DURATION_TOLERANCE_MS;
      checks.push(
        sizeOk && durOk
          ? pass(
              "video_header",
              `the video is ${media.width}x${media.height}, ${(media.durationMs / 1000).toFixed(1)} s, as committed in the manifest`,
            )
          : fail(
              "video_header",
              `the video header (${media.width}x${media.height}, ${media.durationMs} ms) contradicts the manifest (${mm.width}x${mm.height}, ${mm.durationMs} ms)`,
            ),
      );
      if (opts.spec) {
        const want = ASPECT_SIZE[opts.spec.aspect];
        const aspectOk = want !== undefined && want[0] === media.width && want[1] === media.height;
        const specDur = opts.spec.durationS * 1000;
        checks.push(
          aspectOk
            ? pass(
                "matches_brief",
                `resolution ${media.width}x${media.height} is the ${opts.spec.aspect} size in the brief`,
              )
            : fail(
                "matches_brief",
                `resolution ${media.width}x${media.height} is not the ${opts.spec.aspect} size in the brief`,
              ),
        );
        if (Math.abs(media.durationMs - specDur) > 1_500) {
          checks.push(
            warn(
              "brief_duration",
              `the video runs ${(media.durationMs / 1000).toFixed(1)} s; the brief says ${opts.spec.durationS} s`,
            ),
          );
        }
      }
    }
  }
  return { checks, manifest: m, chunksVerified: plain.size, media, complete };
}
