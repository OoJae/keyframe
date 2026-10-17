// Minimal structural views of the Cloudflare bindings this API uses. The real D1/KV/R2 objects satisfy them
// (checked by tsconfig.worker.json via src/worker.ts); tests provide in-memory implementations.

export type SqlValue = string | number | null | Uint8Array;

export interface SqlResult<T> {
  results: T[];
  meta: { changes: number };
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult<unknown>>;
}

/** D1 subset. `batch` runs the statements in one transaction. */
export interface SqlDb {
  prepare(query: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<SqlResult<unknown>[]>;
}

export interface KvLike {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  getWithMetadata<M>(key: string, type: "arrayBuffer"): Promise<{ value: ArrayBuffer | null; metadata: M | null }>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectLike {
  size: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2HeadLike {
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface R2Like {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<unknown>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2HeadLike | null>;
}
