import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { expectOk, HttpError, request, withRetry } from "./http.ts";
import type { JobKind } from "./jobs.ts";
import type { Logger } from "./log.ts";

// Client for the API's internal render-job endpoints (bearer WORKER_TOKEN; X-Worker-Id on job calls).
//   POST /internal/jobs/claim {worker_id, kinds}        → 200 job inputs | 204 nothing to do
//   POST {upload.heartbeat}  {progress}                 → 200 (lease renewed) | 409 lost the job
//   PUT  {upload.still}      image/png bytes            PUT {upload.preview} video/mp4 bytes
//   PUT  {upload.manifest}   KFC1 manifest JSON         PUT {upload.chunk with {i}} ciphertext chunk i
//   POST {upload.done}       {template, renderer, keyframe_at_ms}
//   POST {upload.failed}     {error, retryable}
// The token is held in a private field: it is never logged, never put in an error message and never passed to
// a child process. Every request goes to API_BASE's origin; job-supplied paths cannot redirect it elsewhere.

export type ApiOptions = {
  base: string;
  token: string;
  workerId: string;
  timeoutMs: number;
  uploadTimeoutMs: number;
  log: Logger;
};
export type HeartbeatOutcome = "continue" | "lost";

export class ApiClient {
  readonly #token: string;
  private readonly o: Omit<ApiOptions, "token">;

  constructor(opts: ApiOptions) {
    const { token, ...rest } = opts;
    this.#token = token;
    this.o = rest;
  }

  /** Absolute URL for an /internal path, pinned to API_BASE's origin and path prefix. */
  url(p: string): string {
    if (!p.startsWith("/internal/")) throw new Error("refusing a non-internal API path");
    const base = new URL(this.o.base);
    const u = new URL(`${base.pathname.replace(/\/+$/, "")}${p}`, base.origin);
    if (u.origin !== base.origin) throw new Error("refusing a cross-origin API path");
    return u.href;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, "x-worker-id": this.o.workerId, ...extra };
  }

  private postJson(p: string, body: unknown, signal?: AbortSignal) {
    return request(this.url(p), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      timeoutMs: this.o.timeoutMs,
      signal,
    });
  }

  /** Claim one job. 204 → null. The raw body is returned for the caller to validate. */
  async claim(kinds: JobKind[], signal?: AbortSignal): Promise<unknown | null> {
    return withRetry(
      async () => {
        const res = await this.postJson("/internal/jobs/claim", { worker_id: this.o.workerId, kinds }, signal);
        if (res.status === 204) {
          await res.body?.cancel();
          return null;
        }
        await expectOk(res, "claim");
        return (await res.json()) as unknown;
      },
      // One try only: the API's claim is not idempotent, so a retry after a lost response would strand a job
      // under this worker's lease. The poll loop simply asks again.
      { what: "claim", signal, log: this.o.log, attempts: 1 },
    );
  }

  /** Renew the lease and report progress. 409 (or 403/404) means the job is no longer ours. */
  async heartbeat(p: string, progress: number, signal?: AbortSignal): Promise<HeartbeatOutcome> {
    return withRetry(
      async () => {
        const res = await this.postJson(p, { progress: Math.max(0, Math.min(100, Math.round(progress))) }, signal);
        if (res.status === 409 || res.status === 403 || res.status === 404) {
          await res.body?.cancel();
          return "lost" as const;
        }
        await expectOk(res, "heartbeat");
        await res.body?.cancel();
        return "continue" as const;
      },
      { what: "heartbeat", signal, log: this.o.log },
    );
  }

  /** PUT a file (streamed) or bytes. Returns the API's JSON answer (it re-hashes and validates every upload). */
  async put(
    p: string,
    body: { file: string } | { bytes: Uint8Array },
    contentType: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return withRetry(
      async () => {
        let payload: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>;
        let length: number;
        let close = async () => {};
        if ("file" in body) {
          length = (await stat(body.file)).size;
          const fh = await open(body.file, "r");
          close = () => fh.close();
          payload = Readable.toWeb(fh.createReadStream({ autoClose: false })) as ReadableStream<Uint8Array>;
        } else {
          length = body.bytes.byteLength;
          payload = new Uint8Array(body.bytes);
        }
        try {
          const res = await request(this.url(p), {
            method: "PUT",
            headers: this.headers({ "content-type": contentType, "content-length": String(length) }),
            body: payload,
            duplex: "half",
            timeoutMs: this.o.uploadTimeoutMs,
            signal,
          });
          await expectOk(res, `PUT ${p}`);
          return (await res.json().catch(() => ({}))) as unknown;
        } finally {
          await close();
        }
      },
      { what: `PUT ${p}`, signal, log: this.o.log },
    );
  }

  /** PUT the manifest. A 409 "already set" with the same hash means an earlier try landed: success. */
  async putManifest(p: string, manifest: unknown, manifestHash: string, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.put(
        p,
        { bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
        "application/json",
        signal,
      );
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && e.message.includes(manifestHash))
        return { manifest_hash: manifestHash };
      throw e;
    }
  }

  async done(p: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return withRetry(
      async () => {
        const res = await this.postJson(p, body, signal);
        await expectOk(res, "done");
        return (await res.json().catch(() => ({}))) as unknown;
      },
      { what: "done", signal, log: this.o.log },
    );
  }

  async failed(p: string, error: string, retryable: boolean): Promise<void> {
    await withRetry(
      async () => {
        const res = await this.postJson(p, { error: error.slice(0, 500), retryable });
        await expectOk(res, "failed");
        await res.body?.cancel();
      },
      { what: "failed", log: this.o.log },
    );
  }
}

export { HttpError };
