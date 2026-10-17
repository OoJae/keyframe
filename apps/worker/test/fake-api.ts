import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { bytesToHex, type Hex } from "viem";
import { rawFileKey } from "../src/kfc1.ts";
import {
  decryptKfc1Chunk,
  deriveFileKey,
  jcs,
  type Manifest,
  ManifestSchema,
  newQuoteId,
  parseMp4Header,
  saltOf,
  sha256Hex,
} from "../src/protocol/index.ts";

// An in-memory stand-in for the API's /internal render-job endpoints (apps/api/src/internal/jobs.ts), with the same
// validation the API applies: auth + X-Worker-Id, PNG/WebP and MP4 signatures, ManifestSchema + media vs output,
// every chunk decrypted with the key derived from K_chain/K_buyer (the plugin's path), and `done` only after
// every artifact is in. Used by the client and service tests.

export type Fault = { method: string; prefix: string; status: number; times: number };

type Held = {
  inputs: Record<string, unknown> & {
    job_id: string;
    kind: string;
    output: { width: number; height: number; duration_s: number; fps: number };
  };
  kChain: Hex;
  kBuyer: Hex;
  salt: Hex;
  status: "queued" | "claimed" | "done" | "failed";
  worker: string | null;
  lost: boolean;
  still?: Buffer;
  stillType?: string;
  preview?: Buffer;
  manifest?: Manifest;
  manifestHash?: string;
  chunks: Map<number, Buffer>;
  heartbeats: number[];
  done?: Record<string, unknown>;
  failed?: { error: string; retryable: boolean };
};

export class FakeApi {
  readonly token: string;
  readonly jobs = new Map<string, Held>();
  readonly order: string[] = [];
  readonly claims: Record<string, unknown>[] = [];
  readonly requests: { method: string; path: string; auth: string | undefined; worker: string | undefined }[] = [];
  readonly faults: Fault[] = [];
  private server: Server | null = null;
  base = "";

  constructor(token: string) {
    this.token = token;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      this.server?.closeAllConnections();
      this.server?.close(() => r());
    });
  }

  /** Queue a job shaped exactly like the API's jobInputs(); `over` patches the top level. */
  async enqueue(
    o: {
      template?: Record<string, unknown> | null;
      output?: Record<string, unknown>;
      params?: Record<string, unknown>;
      over?: Record<string, unknown>;
      delivery?: "public" | "private";
    } = {},
  ): Promise<string> {
    const id = `j_${randomBytes(16).toString("hex")}`;
    const quoteId = newQuoteId();
    const salt = saltOf(quoteId);
    const kChain = bytesToHex(randomBytes(32));
    const kBuyer = o.delivery === "private" ? bytesToHex(randomBytes(32)) : bytesToHex(new Uint8Array(32));
    const p = (s: string) => `/internal/jobs/${id}/${s}`;
    const inputs = {
      job_id: id,
      kind: "instant_render",
      attempt: 1,
      lease_expires_at: Math.floor(Date.now() / 1000) + 600,
      quote_id: quoteId,
      order_id: null,
      template:
        o.template === undefined ? { id: "probe", catalog_id: "probe", format: "catalog", style: "probe" } : o.template,
      output: {
        mime: "video/mp4",
        aspect: "9:16",
        width: 1080,
        height: 1920,
        duration_s: 2,
        fps: 30,
        hero_ms: 1000,
        faststart: true,
        ...o.output,
      },
      params: o.params ?? {
        catalog_id: "probe",
        values: { probe_id: "fake-api" },
        sound: "studio",
        receipt_end_card: true,
      },
      data_snapshot: null,
      watermark: { text: `KEYFRAME · PREVIEW · ${quoteId}` },
      kfc1: {
        alg: "KFC1",
        salt,
        k_file: await rawFileKey(kChain, kBuyer, salt),
        chunk_size: 1_048_560,
        nonce: "0x00000000 ‖ u64be(i)",
        aad: "…",
      },
      requires: ["still", "preview", "manifest", "chunks"],
      upload: {
        still: p("still"),
        preview: p("preview"),
        manifest: p("manifest"),
        chunk: p("chunks/{i}"),
        heartbeat: p("heartbeat"),
        done: p("done"),
        failed: p("failed"),
      },
      ...o.over,
    } as Held["inputs"];
    this.jobs.set(id, {
      inputs,
      kChain,
      kBuyer,
      salt,
      status: "queued",
      worker: null,
      lost: false,
      chunks: new Map(),
      heartbeats: [],
    });
    this.order.push(id);
    return id;
  }

  /** Make the API stop recognising this worker's hold on a job (lease expired / re-assigned). */
  lose(id: string): void {
    const j = this.jobs.get(id);
    if (j) j.lost = true;
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const worker = req.headers["x-worker-id"] as string | undefined;
    this.requests.push({ method, path: p, auth: req.headers.authorization, worker });
    const json = (code: number, body?: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const fault = this.faults.find((f) => f.method === method && p.startsWith(f.prefix) && f.times > 0);
    if (fault) {
      fault.times--;
      await this.body(req);
      return json(fault.status, { error: "injected" });
    }
    if (!p.startsWith("/internal/")) return json(404, {});
    if (req.headers.authorization !== `Bearer ${this.token}`) return json(401, { error: "unauthorized" });
    const raw = await this.body(req);

    if (p === "/internal/jobs/claim" && method === "POST") {
      const b = JSON.parse(raw.toString("utf8")) as { worker_id: string; kinds?: string[] };
      this.claims.push(b);
      const id = this.order.find(
        (i) =>
          this.jobs.get(i)?.status === "queued" &&
          (b.kinds ?? ["instant_render"]).includes(this.jobs.get(i)?.inputs.kind ?? ""),
      );
      if (!id) return json(204);
      const j = this.jobs.get(id) as Held;
      j.status = "claimed";
      j.worker = b.worker_id;
      return json(200, j.inputs);
    }

    const m = /^\/internal\/jobs\/([^/]+)\/(still|preview|manifest|chunks\/(\d+)|heartbeat|done|failed)$/.exec(p);
    const j = m?.[1] ? this.jobs.get(m[1]) : undefined;
    if (!m || !j) return json(404, { error: "unknown_job" });
    if (j.status !== "claimed") return json(409, { error: "job_not_claimed", status: j.status });
    if (!worker || worker !== j.worker) return json(403, { error: "job_held_by_another_worker" });
    if (j.lost) return json(409, { error: "lease_expired" });
    const type = String(req.headers["content-type"] ?? "").split(";")[0];
    const sig = (b: Buffer, s: number[], at = 0) => s.every((x, i) => b[at + i] === x);
    const key = () => deriveFileKey(j.kChain, j.kBuyer, j.salt);

    switch (m[2]) {
      case "heartbeat":
        j.heartbeats.push(Number((JSON.parse(raw.toString("utf8") || "{}") as { progress?: number }).progress ?? -1));
        return json(200, { ok: true });
      case "still":
        if (
          !(
            (type === "image/png" && sig(raw, [0x89, 0x50, 0x4e, 0x47])) ||
            (type === "image/webp" && sig(raw, [0x52, 0x49, 0x46, 0x46]))
          ) ||
          raw.length > 2 * 1024 * 1024
        ) {
          return json(422, { error: "still_must_be_webp_or_png" });
        }
        j.still = raw;
        j.stillType = type;
        return json(200, { sha256: await sha256Hex(raw) });
      case "preview":
        if (type !== "video/mp4" || !sig(raw, [0x66, 0x74, 0x79, 0x70], 4))
          return json(422, { error: "preview_not_mp4" });
        j.preview = raw;
        return json(200, { sha256: await sha256Hex(raw) });
      case "manifest": {
        const r = ManifestSchema.safeParse(JSON.parse(raw.toString("utf8")));
        if (!r.success) return json(422, { error: "manifest_invalid" });
        const mf = r.data;
        const o = j.inputs.output;
        if (mf.salt !== j.salt) return json(422, { error: "manifest_salt_mismatch" });
        if (mf.media.width !== o.width || mf.media.height !== o.height || mf.media.fps !== o.fps)
          return json(422, { error: "media" });
        if (Math.abs(mf.media.durationMs - o.duration_s * 1000) > 34) return json(422, { error: "media_duration" });
        const hash = await sha256Hex(jcs(mf));
        if (j.manifestHash) return json(409, { error: "manifest_already_set", manifest_hash: j.manifestHash });
        j.manifest = mf;
        j.manifestHash = hash;
        return json(200, { manifest_hash: hash });
      }
      case "done": {
        if (!j.manifest || !j.manifestHash) return json(409, { error: "manifest_missing" });
        for (let i = 0; i < j.manifest.chunks; i++)
          if (!j.chunks.has(i)) return json(409, { error: "chunk_missing", index: i });
        if (!j.preview || !j.still) return json(409, { error: "artifact_missing" });
        const k = await key();
        const parts: Uint8Array[] = [];
        for (let i = 0; i < j.manifest.chunks; i++)
          parts.push(await decryptKfc1Chunk(j.chunks.get(i) as Buffer, i, j.manifest.chunks, k, j.salt));
        if ((await sha256Hex(Buffer.concat(parts))) !== j.manifest.plaintextSha256)
          return json(422, { error: "self_verify_failed" });
        j.done = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        j.status = "done";
        return json(200, { job_id: j.inputs.job_id, status: "final", manifest_hash: j.manifestHash });
      }
      case "failed": {
        const b = JSON.parse(raw.toString("utf8")) as { error: string; retryable?: boolean };
        j.failed = { error: b.error, retryable: b.retryable ?? true };
        j.status = "failed";
        return json(200, { job_id: j.inputs.job_id, status: "failed" });
      }
      default: {
        const i = Number(m[3]);
        if (!j.manifest) return json(409, { error: "upload_manifest_first" });
        if ((await sha256Hex(raw)) !== j.manifest.ciphertext[i]) return json(422, { error: "chunk_ciphertext_hash" });
        let pt: Uint8Array;
        try {
          pt = await decryptKfc1Chunk(raw, i, j.manifest.chunks, await key(), j.salt);
        } catch {
          return json(422, { error: "chunk_decrypt" });
        }
        if (i === 0 && !parseMp4Header(pt)) return json(422, { error: "mp4_not_faststart" });
        j.chunks.set(i, raw);
        return json(200, { index: i });
      }
    }
  }
}
