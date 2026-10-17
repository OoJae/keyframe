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
