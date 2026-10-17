import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KFC1_CHUNK_PLAINTEXT, sha256Hex, termsFromJson } from "@keyframe/protocol";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { type Address, bytesToHex, getAddress, type Hex, hexToBytes, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/app.js";
import type { ChainReader } from "../../src/chain.js";
import { parseConfig, type RawEnv } from "../../src/config.js";
import { Repo } from "../../src/db/repo.js";
import type { RelayerClient } from "../../src/relayer/types.js";
import { Sanctions } from "../../src/sanctions.js";
import type { Logger, Services } from "../../src/services.js";
import { KeyframeFacilitator } from "../../src/x402/facilitator.js";
import { X402Runtime } from "../../src/x402/server.js";
import { SqliteD1 } from "./d1.js";
import { FakeFactory, MemoryStorage, StubChain, StubRelayer } from "./fakes.js";

export const FACTORY = getAddress("0x00000000000000000000000000000000000f4c70");
export const SELLER = getAddress("0x2222222222222222222222222222222222222222");
export const SANCTIONED = privateKeyToAccount(generatePrivateKey());
export const PUBLIC_BASE = "https://api.keyframe.test";
export const WORKER_TOKEN = "test-worker-token-0123456789abcdefghijklmnop";
export const WORKER_ID = "worker-1";
const FIXTURES = join(import.meta.dirname, "../fixtures");

export const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** Appends an ISO-BMFF `free` box so the file spans several KFC1 chunks (moov stays in chunk 0). */
export function padMp4(mp4: Uint8Array, totalBytes: number): Uint8Array<ArrayBuffer> {
  const pad = totalBytes - mp4.byteLength;
  const out = new Uint8Array(totalBytes);
  out.set(mp4, 0);
  new DataView(out.buffer).setUint32(mp4.byteLength, pad);
  out.set([0x66, 0x72, 0x65, 0x65], mp4.byteLength + 4);
  return out;
}

export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

/** Untyped JSON response bodies in tests (the schemas under test are asserted explicitly). */
// biome-ignore lint/suspicious/noExplicitAny: test-only alias for parsed JSON bodies
export type Json = Record<string, any>;

const silent: Logger = { info() {}, warn() {}, error() {} };

export interface HarnessOptions {
  env?: Partial<RawEnv>;
  /** Real chain reader / relayer (anvil e2e) instead of the in-memory fakes. */
  chain?: ChainReader;
  relayer?: RelayerClient;
  buyer?: LocalAccount;
  relayerKey?: Hex;
  /** PayAI-style fallback facilitator. */
  fallback?: FacilitatorClient | null;
  sanctionsFetchedAgoS?: number | null;
}

export class Harness {
  readonly db = new SqliteD1();
  readonly repo = new Repo(this.db);
  readonly storage = new MemoryStorage();
  readonly buyer: LocalAccount;
  readonly relayerKey: Hex;
  readonly kmasterHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  nowMs = Date.now();
  readonly factory = new FakeFactory(FACTORY, () => Math.floor(this.nowMs / 1000));
  readonly relayer = new StubRelayer(this.factory);
  readonly chain = new StubChain(this.factory);
  readonly s: Services;
  readonly app: ReturnType<typeof createApp>;
  private readonly pendingBackground: Promise<unknown>[] = [];
  listFetch: () => Promise<Response> = async () => new Response("[]");
  /**
   * A render worker that polls constantly (seen at every request), so Instant quotes are not refused as
   * studio_offline. Liveness tests turn it off with stopRenderWorker().
   */
  private renderWorkerAlive = true;
  static readonly RENDER_WORKER_ID = "harness-render-worker";

  constructor(o: HarnessOptions = {}) {
    this.buyer = o.buyer ?? privateKeyToAccount(generatePrivateKey());
    this.relayerKey = o.relayerKey ?? generatePrivateKey();
    const chain = o.chain ?? this.chain;
    const relayer = o.relayer ?? this.relayer;
    const env: RawEnv = {
      PUBLIC_BASE_URL: PUBLIC_BASE,
      FACTORY_ADDRESS: FACTORY,
      SELLER_ADDRESS: SELLER,
      RPC_URL: "http://127.0.0.1:1",
      KMASTER: this.kmasterHex,
      ACCESS_SECRET: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      WORKER_TOKEN,
      RELAYER_PRIVATE_KEY: this.relayerKey,
      FORMATS_DISABLED: "chart_moment",
      ...o.env,
    };
    const cfg = parseConfig(env);
    if (cfg.problems.length) throw new Error(`test config: ${cfg.problems.join("; ")}`);
    const nowMs = () => this.nowMs;
    const sanctions = new Sanctions(this.repo, {
      listUrl: cfg.ofacListUrl,
      maxAgeS: cfg.ofacMaxAgeS,
      fetch: (() => this.listFetch()) as unknown as typeof fetch,
      nowMs,
    });
    const facilitator = new KeyframeFacilitator({
      signer: () => chain.x402Signer(cfg.operator ? [cfg.operator] : []),
      relayer,
      fallback: o.fallback ?? null,
      receiptWaitMs: cfg.receiptWaitMs,
      chain,
      factory: cfg.factory,
      usdc: cfg.usdc,
    });
    this.s = {
      cfg,
      repo: this.repo,
      storage: this.storage,
      chain,
      relayer,
      sanctions,
      facilitator,
      x402: new X402Runtime(facilitator, cfg.usdc),
      nowMs,
      log: silent,
    };
    this.app = createApp({ services: () => this.s });
    const ago = o.sanctionsFetchedAgoS === undefined ? 0 : o.sanctionsFetchedAgoS;
    if (ago !== null) {
      const addresses = [
        SANCTIONED.address.toLowerCase(),
        ...Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`),
      ];
      this.db.raw
        .prepare("INSERT INTO sanctions_lists (fetched_at, source, sha256, count, addresses) VALUES (?, ?, ?, ?, ?)")
        .run(this.nowS() - ago, "test", "0x", addresses.length, JSON.stringify(addresses.sort()));
    }
  }

  nowS(): number {
    return Math.floor(this.nowMs / 1000);
  }
  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  get operator(): Address {
    return privateKeyToAccount(this.relayerKey).address;
  }

  /** The background render worker goes away (its last-seen row is removed). */
  stopRenderWorker(): void {
    this.renderWorkerAlive = false;
    this.db.raw.prepare("DELETE FROM worker_heartbeats WHERE worker_id = ?").run(Harness.RENDER_WORKER_ID);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.renderWorkerAlive) {
      this.db.raw
        .prepare(
          `INSERT INTO worker_heartbeats (worker_id, seen_at) VALUES (?, ?)
           ON CONFLICT (worker_id) DO UPDATE SET seen_at = excluded.seen_at`,
        )
        .run(Harness.RENDER_WORKER_ID, this.nowS());
    }
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        this.pendingBackground.push(p);
      },
      passThroughOnException() {},
      props: {},
    };
    return this.app.request(`${PUBLIC_BASE}${path}`, init, {}, ctx as never);
  }

  /** waitUntil() promises queued and not yet drained. */
  get backgroundCount(): number {
    return this.pendingBackground.length;
  }

  /** Await every waitUntil() promise queued so far (and any they queue). */
  async drain(): Promise<void> {
    while (this.pendingBackground.length) await Promise.allSettled(this.pendingBackground.splice(0));
  }

  async postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  internal(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${WORKER_TOKEN}`);
    headers.set("x-worker-id", WORKER_ID);
    return this.request(path.startsWith("/internal/") ? path : `/internal${path}`, { ...init, headers });
  }

  /** Default order: an 8 s Countdown (1.00 USDC), the Instant format whose template is designed (reference). */
  quoteBody(over: Record<string, unknown> = {}) {
    return {
      buyer: this.buyer.address,
      format: "countdown",
      aspect: "9:16",
      rights_confirmed: true,
      params: {
        style: "tminus",
        label: "Mainnet",
        target: new Date(this.nowMs + 86_400_000).toISOString(),
        cta: "Join us",
      },
      ...over,
    };
  }

  async createQuote(over: Record<string, unknown> = {}) {
    const res = await this.postJson("/v1/quotes", this.quoteBody(over));
    if (res.status !== 201) throw new Error(`quote ${res.status}: ${await res.text()}`);
    return (await res.json()) as Json;
  }

  /** Plays the render worker for the next queued job: claim, upload, done. */
  async render(
    opts: {
      mp4?: Uint8Array<ArrayBuffer>;
      totalBytes?: number;
      template?: Record<string, string>;
      skipDone?: boolean;
    } = {},
  ) {
    const claim = await this.internal("/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: WORKER_ID }),
    });
    if (claim.status !== 200) throw new Error(`claim ${claim.status}`);
    const job = (await claim.json()) as Json;
    const mp4 = opts.mp4 ?? fixture("countdown-8s-9x16.m4v");
    const plaintext = opts.totalBytes ? padMp4(mp4, opts.totalBytes) : mp4;
    const up = async (path: string, body: BodyInit, type: string) => {
      const r = await this.internal(path, { method: "PUT", headers: { "content-type": type }, body });
      if (r.status !== 200) throw new Error(`${path} ${r.status}: ${await r.text()}`);
      return (await r.json()) as Json;
    };
    if (job.kind === "instant_render") await up(job.upload.still, PNG, "image/png");
    await up(job.upload.preview, mp4, "video/mp4");
    const enc = await encryptWithRawKey(plaintext, job.kfc1.k_file, job.kfc1.salt, {
      mime: "video/mp4",
      width: job.output.width,
      height: job.output.height,
      durationMs: job.output.duration_s * 1000,
      fps: 30,
    });
    await up(job.upload.manifest, JSON.stringify(enc.manifest), "application/json");
    for (const [i, c] of enc.chunks.entries())
      await up(job.upload.chunk.replace("{i}", String(i)), c, "application/octet-stream");
    if (opts.skipDone) return { job, enc, done: null };
    const done = await this.internal(`/jobs/${job.job_id}/done`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: opts.template ?? { id: job.template?.id ?? "studio", version: "1.0.0", hash: `0x${"ab".repeat(32)}` },
        renderer: { name: "hyperframes", version: "0.8.140" },
        keyframe_at_ms: job.output.hero_ms,
      }),
    });
    return { job, enc, done };
  }

  /** Plays the Studio CLI: open a delivery job for a paid Studio order, upload preview + KFC1 master, done. */
  async deliverStudio(orderId: string, mp4: Uint8Array<ArrayBuffer> = fixture("studio-10s-9x16.m4v")) {
    const open = await this.internal(`/studio/orders/${orderId}/delivery`, { method: "POST" });
    if (open.status !== 200) throw new Error(`delivery ${open.status}: ${await open.text()}`);
    const job = (await open.json()) as Json;
    const put = async (path: string, body: BodyInit, type: string) => {
      const r = await this.internal(path, { method: "PUT", headers: { "content-type": type }, body });
      if (r.status !== 200) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    };
    await put(job.upload.preview, mp4, "video/mp4");
    const enc = await encryptWithRawKey(mp4, job.kfc1.k_file, job.kfc1.salt, {
      mime: "video/mp4",
      width: job.output.width,
      height: job.output.height,
      durationMs: job.output.duration_s * 1000,
      fps: 30,
    });
    await put(job.upload.manifest, JSON.stringify(enc.manifest), "application/json");
    for (const [i, c] of enc.chunks.entries()) {
      await put(job.upload.chunk.replace("{i}", String(i)), c, "application/octet-stream");
    }
    const done = await this.internal(`/jobs/${job.job_id}/done`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (done.status !== 200) throw new Error(`done ${done.status}: ${await done.text()}`);
    return (await done.json()) as Json;
  }

  async finalQuote(over: Record<string, unknown> = {}) {
    const q = await this.createQuote(over);
    const { done } = await this.render();
    if (done?.status !== 200) throw new Error(`done ${done?.status}: ${await done?.text()}`);
    const r = await this.request(`/v1/quotes/${q.quote_id}`);
    return (await r.json()) as Json;
  }

  /** A real x402 client (the same libraries any buyer uses) signs an EIP-3009 authorization for the 402. */
  async paymentHeaders(quoteId: string, account: LocalAccount = this.buyer): Promise<Record<string, string>> {
    const res = await this.request(`/v1/orders/${quoteId}`, { method: "POST" });
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    client.setSpendControls(false);
    const http = new x402HTTPClient(client);
    const body = await res.json().catch(() => ({}));
    const required = http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
    return http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
  }

  pay(quoteId: string, headers: Record<string, string>, method = "POST") {
    return this.request(`/v1/orders/${quoteId}`, { method, headers });
  }

  terms(quote: Json) {
    return termsFromJson(quote.terms);
  }
}

const u64be = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

/** Independent KFC1 encryption with the raw K_file the worker receives (not the protocol's helper). */
export async function encryptWithRawKey(
  plaintext: Uint8Array,
  kFile: Hex,
  salt: Hex,
  media: { mime: string; width: number; height: number; durationMs: number; fps: number },
) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(hexToBytes(kFile)), "AES-GCM", false, ["encrypt"]);
  const n = Math.ceil(plaintext.byteLength / KFC1_CHUNK_PLAINTEXT);
  const saltBytes = hexToBytes(salt);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const ciphertext: Hex[] = [];
  const plain: Hex[] = [];
  for (let i = 0; i < n; i++) {
    const pt = new Uint8Array(plaintext).slice(i * KFC1_CHUNK_PLAINTEXT, (i + 1) * KFC1_CHUNK_PLAINTEXT);
    const iv = new Uint8Array(12);
    iv.set(u64be(i), 4);
    const aad = new Uint8Array([...new TextEncoder().encode("KFC1"), ...saltBytes, ...u64be(i), ...u64be(n)]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, pt));
    chunks.push(ct);
    ciphertext.push(await sha256Hex(ct));
    plain.push(await sha256Hex(pt));
  }
  const manifest = {
    v: 1,
    alg: "KFC1",
    salt: salt.toLowerCase(),
    chunkSize: KFC1_CHUNK_PLAINTEXT,
    size: plaintext.byteLength,
    chunks: n,
    plaintextSha256: await sha256Hex(plaintext),
    ciphertext,
    plaintext: plain,
    media,
  };
  return { manifest, chunks };
}
