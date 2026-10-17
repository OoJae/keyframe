// Integration: the real worker service against FakeApi (the API's /internal contract), rendering with HyperFrames
// + ffmpeg and sealing with the job's K_file. Skips itself when the browser or ffmpeg is unavailable.
// Run: npm run test:integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadServiceConfig } from "../../src/config.ts";
import { preflight } from "../../src/preflight.ts";
import { RenderWorker } from "../../src/service.ts";
import { loadTemplate } from "../../src/templates.ts";
import { FakeApi } from "../fake-api.ts";
import { captureLogger, TEMPLATES, tempDir } from "../helpers.ts";

const TOKEN = "integration-worker-token-0123456789abcdefghijkl";
const sha = (b: Buffer) => `0x${createHash("sha256").update(b).digest("hex")}`;
const workDir = await tempDir("kfw-int-");
const { report } = await preflight(
  loadServiceConfig({
    TEMPLATES_DIR: TEMPLATES,
    WORK_DIR: workDir,
    API_BASE: "http://127.0.0.1:1",
    WORKER_TOKEN: TOKEN,
  }),
);
const probe = await loadTemplate(TEMPLATES, "probe");
const countdown = await loadTemplate(TEMPLATES, "countdown");

const waitFor = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
};

describe("render worker service (integration)", {
  skip: report.ok ? false : `preflight: ${report.problems.join("; ")}`,
  timeout: 900_000,
}, () => {
  let api: FakeApi;
  let worker: RenderWorker;
  const logs = captureLogger("debug");
  const settled = (id: string) => ["done", "failed"].includes(api.jobs.get(id)?.status ?? "");

  before(async () => {
    api = await new FakeApi(TOKEN).start();
    worker = new RenderWorker(
      loadServiceConfig({
        API_BASE: api.base,
        WORKER_TOKEN: TOKEN,
        WORKER_ID: "int-1",
        TEMPLATES_DIR: TEMPLATES,
        WORK_DIR: workDir,
        HEALTH_PORT: "0",
        POLL_INTERVAL_MS: "200",
        HEARTBEAT_INTERVAL_MS: "1000",
        DRAIN_TIMEOUT_MS: "1000",
      }),
      logs.log,
    );
    await worker.start();
  });
  after(async () => {
    await worker?.stop();
    await api?.stop();
  });

  it("is ready and serves health without secrets", async () => {
    await waitFor(() => api.claims.length > 0, 30_000, "first claim");
    const h = await fetch(`http://127.0.0.1:${worker.healthPort}/healthz`);
    assert.equal(h.status, 200);
    const body = (await h.json()) as { status: string; templates: { id: string; hash: string }[] };
    assert.equal(body.status, "ready");
    assert.deepEqual(body.templates.map((t) => t.id).sort(), ["countdown", "probe"]);
    assert.equal(body.templates.find((t) => t.id === "probe")?.hash, probe.hash);
    assert.equal((await fetch(`http://127.0.0.1:${worker.healthPort}/readyz`)).status, 200);
    assert.deepEqual(api.claims[0], { worker_id: "int-1", kinds: ["instant_render"] });
  });

  it("fails bad jobs with the right codes, without rendering", async () => {
    const ids = {
      shape: await api.enqueue({ over: { output: { mime: "video/webm" } } }),
      awaiting: await api.enqueue({
        template: { id: "launch-sting", catalog_id: "launch_sting", format: "launch_sting", style: "instrument" },
        output: { duration_s: 6, hero_ms: 3400 },
      }),
      style: await api.enqueue({ template: { id: "probe", catalog_id: "probe", format: "catalog", style: "neon" } }),
      vars: await api.enqueue({
        template: { id: "countdown", catalog_id: "countdown", format: "countdown", style: "tminus" },
        output: { duration_s: 8, hero_ms: 3000 },
        params: { label: "x", target: "not a date" },
      }),
      duration: await api.enqueue({ output: { duration_s: 5 } }),
    };
    await waitFor(() => Object.values(ids).every(settled), 30_000, "five failures");
    const f = (id: string) => api.jobs.get(id)?.failed;
    assert.deepEqual([f(ids.shape)?.retryable, f(ids.shape)?.error.split(":")[0]], [false, "bad_job"]);
    assert.deepEqual([f(ids.awaiting)?.retryable, f(ids.awaiting)?.error.split(":")[0]], [false, "bad_template"]);
    assert.deepEqual([f(ids.style)?.retryable, f(ids.style)?.error.split(":")[0]], [false, "bad_template"]);
    assert.deepEqual([f(ids.vars)?.retryable, f(ids.vars)?.error.split(":")[0]], [false, "bad_variables"]);
    assert.deepEqual([f(ids.duration)?.retryable, f(ids.duration)?.error.split(":")[0]], [false, "bad_template"]);
    for (const id of Object.values(ids)) assert.equal(api.jobs.get(id)?.still, undefined, "nothing uploaded");
  });

  const renderAndCheck = async (
    id: string,
    want: {
      template: typeof probe;
      width: number;
      height: number;
      durationMs: number;
      still: [number, number];
      atMs: number;
    },
  ) => {
    await waitFor(() => settled(id), 300_000, id);
    const j = api.jobs.get(id);
    assert.ok(j && j.status === "done", JSON.stringify(j?.failed));
    assert.deepEqual(j.done?.template, {
      id: j.inputs.template && (j.inputs.template as { id: string }).id,
      version: want.template.meta.version,
      hash: want.template.hash,
    });
    assert.deepEqual(j.done?.renderer, { name: "hyperframes", version: "0.8.140" });
    assert.equal(j.done?.keyframe_at_ms, want.atMs);
    assert.equal(j.stillType, "image/png");
    assert.ok(j.still && j.preview && j.manifest && j.manifestHash);
    assert.deepEqual(j.manifest.media, {
      mime: "video/mp4",
      width: want.width,
      height: want.height,
      durationMs: want.durationMs,
      fps: 30,
    });
    const chunk0 = j.chunks.get(0) as Buffer;
    assert.equal(sha(chunk0), j.manifest.ciphertext[0]);
    assert.ok(j.heartbeats.length > 0, "lease renewed");
    assert.ok(
      j.heartbeats.every((p, i) => i === 0 || p >= (j.heartbeats[i - 1] ?? 0)),
      "progress is monotonic",
    );
    return j;
  };

  it("renders a probe job end to end: still, preview, KFC1 manifest + chunks the API can decrypt, done", async () => {
    const id = await api.enqueue();
    const j = await renderAndCheck(id, {
      template: probe,
      width: 1080,
      height: 1920,
      durationMs: 2000,
      still: [540, 960],
      atMs: 1000,
    });
    assert.equal(j.manifest?.chunks, 1);
  });

  it("renders a countdown job from raw quote params at 16:9 (params → variables, palette, multi-second ticks)", async () => {
    const id = await api.enqueue({
      template: { id: "countdown", catalog_id: "countdown", format: "countdown", style: "tminus" },
      output: { aspect: "16:9", width: 1920, height: 1080, duration_s: 8, hero_ms: 3000 },
      params: {
        style: "tminus",
        label: "Mainnet launch",
        target: "2026-10-24T18:00:00Z",
        cta: "Set a reminder",
        sound: "studio",
        receipt_end_card: true,
        palette: { bg: "#0d1b2a", fg: "#f4f4f4", accent: "#7f8c8d" },
      },
      delivery: "private",
    });
    await renderAndCheck(id, {
      template: countdown,
      width: 1920,
      height: 1080,
      durationMs: 8000,
      still: [960, 540],
      atMs: 3000,
    });
  });

  it("stops a job whose lease the API no longer recognises, without reporting done", async () => {
    const id = await api.enqueue();
    await waitFor(
      () => (api.jobs.get(id)?.heartbeats.length ?? 0) > 0 || api.jobs.get(id)?.status === "claimed",
      30_000,
      "claim",
    );
    api.lose(id);
    await waitFor(() => worker.status().jobs.lost >= 1, 120_000, "lost job");
    assert.equal(api.jobs.get(id)?.done, undefined);
  });

  it("cleans up job directories and never logs the token or the K_file", async () => {
    await waitFor(() => worker.status().jobs.active.length === 0, 60_000, "idle");
    const jobsDir = path.join(workDir, "jobs");
    assert.deepEqual(existsSync(jobsDir) ? await readdir(jobsDir) : [], []);
    const text = logs.text();
    assert.ok(text.length > 0);
    assert.ok(!text.includes(TOKEN), "token in logs");
    for (const j of api.jobs.values()) {
      const kFile = (j.inputs.kfc1 as { k_file: string }).k_file;
      assert.ok(!text.includes(kFile.slice(2)), "K_file in logs");
    }
    const s = worker.status().jobs;
    assert.deepEqual([s.done, s.failed, s.lost], [2, 4, 1]);
  });
});
