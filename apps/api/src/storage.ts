import type { KvLike, R2Like } from "./platform.js";

// Public, immutable artifact storage (frozen-interfaces.md §5 layout under FILES_BASE):
//   s/{quote_id}-{tag}.{webp|png}   watermarked key-frame still (tag = job + attempt)
//   p/{quote_id}-{tag}.mp4          watermarked preview
//   c/{manifestHash}/manifest.json, c/{manifestHash}/{i}.bin   KFC1 manifest + ciphertext chunks
// R2 when the FILES binding exists, else KV (values ≤ 25 MiB; chunks are 1 MiB).

export interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface StorageAdapter {
  readonly kind: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  exists(key: string): Promise<boolean>;
  /** Native byte-range read (R2 reads only the range); adapters without it are sliced from get(). */
  getRange?(key: string, spec: RangeSpec): Promise<RangedObject | null>;
}

/** One `Range: bytes=…` request: first-last (last open-ended when null) or the final `suffix` bytes. */
export type RangeSpec = { first: number; last: number | null } | { suffix: number };

export interface ByteRange {
  offset: number;
  length: number;
}

export interface RangedObject {
  contentType: string;
  /** Size of the whole object. */
  size: number;
  /** The satisfiable range, or null (416). */
  range: ByteRange | null;
  /** The range's bytes (empty when unsatisfiable). */
  bytes: Uint8Array<ArrayBuffer>;
}

const RANGE_RE = /^bytes=(\d{0,15})-(\d{0,15})$/;

/**
 * A single byte range (RFC 9110 §14.1.2). null = serve the whole object: no header, another unit, several ranges or a
 * syntactically invalid one (last < first), all of which a server may ignore.
 */
export function parseRange(header: string | null | undefined): RangeSpec | null {
  const m = header ? RANGE_RE.exec(header.trim()) : null;
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (a === "") return { suffix: Number(b) };
  const first = Number(a);
  const last = b === "" ? null : Number(b);
  return last !== null && last < first ? null : { first, last };
}

/** The range within an object of `size` bytes, or null when it is not satisfiable. */
export function resolveRange(spec: RangeSpec, size: number): ByteRange | null {
  if ("suffix" in spec) {
    const length = Math.min(spec.suffix, size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  if (spec.first >= size) return null;
  const last = spec.last === null ? size - 1 : Math.min(spec.last, size - 1);
  return { offset: spec.first, length: last - spec.first + 1 };
}

export async function readRange(storage: StorageAdapter, key: string, spec: RangeSpec): Promise<RangedObject | null> {
  if (storage.getRange) return storage.getRange(key, spec);
  const o = await storage.get(key);
  if (!o) return null;
  const range = resolveRange(spec, o.bytes.byteLength);
  return {
    contentType: o.contentType,
    size: o.bytes.byteLength,
    range,
    bytes: range ? o.bytes.slice(range.offset, range.offset + range.length) : new Uint8Array(0),
  };
}

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const KEY_RE =
  /^(?:s\/q_[1-9A-HJ-NP-Za-km-z]{22}-[0-9a-f]{8}-\d{1,3}\.(?:webp|png)|p\/q_[1-9A-HJ-NP-Za-km-z]{22}-[0-9a-f]{8}-\d{1,3}\.mp4|c\/0x[0-9a-f]{64}\/(?:manifest\.json|\d{1,5}\.bin))$/;

/** Only these keys are ever written or served publicly. */
export const isPublicKey = (key: string): boolean => KEY_RE.test(key);

/** Stills and previews are keyed per job attempt (`tag`) so a re-render never reuses an immutable URL. */
export const keys = {
  still: (quoteId: string, tag: string, ext: "webp" | "png") => `s/${quoteId}-${tag}.${ext}`,
  preview: (quoteId: string, tag: string) => `p/${quoteId}-${tag}.mp4`,
  manifest: (manifestHash: string) => `c/${manifestHash}/manifest.json`,
  chunk: (manifestHash: string, i: number) => `c/${manifestHash}/${i}.bin`,
};

export class R2Storage implements StorageAdapter {
  readonly kind = "r2" as const;
  private readonly bucket: R2Like;
  constructor(bucket: R2Like) {
    this.bucket = bucket;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl: IMMUTABLE_CACHE } });
  }
  async get(key: string): Promise<StoredObject | null> {
    const o = await this.bucket.get(key);
    if (!o) return null;
    return {
      bytes: new Uint8Array(await o.arrayBuffer()),
      contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }
  async exists(key: string): Promise<boolean> {
    return (await this.bucket.head(key)) !== null;
  }
  async getRange(key: string, spec: RangeSpec): Promise<RangedObject | null> {
    const head = await this.bucket.head(key);
    if (!head) return null;
    const contentType = head.httpMetadata?.contentType ?? "application/octet-stream";
    const range = resolveRange(spec, head.size);
    if (!range) return { contentType, size: head.size, range: null, bytes: new Uint8Array(0) };
    const o = await this.bucket.get(key, { range });
    if (!o) return null;
    return { contentType, size: head.size, range, bytes: new Uint8Array(await o.arrayBuffer()) };
  }
}

export class KvStorage implements StorageAdapter {
  readonly kind = "kv" as const;
  private readonly kv: KvLike;
  private readonly prefix: string;
  constructor(kv: KvLike, prefix = "files/") {
    this.kv = kv;
    this.prefix = prefix;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.kv.put(this.prefix + key, bytes, { metadata: { contentType } });
  }
  async get(key: string): Promise<StoredObject | null> {
    const r = await this.kv.getWithMetadata<{ contentType?: string }>(this.prefix + key, "arrayBuffer");
    if (!r.value) return null;
    return { bytes: new Uint8Array(r.value), contentType: r.metadata?.contentType ?? "application/octet-stream" };
  }
  async exists(key: string): Promise<boolean> {
    return (await this.kv.get(this.prefix + key, "arrayBuffer")) !== null;
  }
}

export function storageFor(bindings: { FILES?: R2Like; KV?: KvLike }): StorageAdapter | null {
  if (bindings.FILES) return new R2Storage(bindings.FILES);
  if (bindings.KV) return new KvStorage(bindings.KV);
  return null;
}
