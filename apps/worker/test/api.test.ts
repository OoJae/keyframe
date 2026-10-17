import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ApiClient } from "../src/api.ts";
import { HttpError, withRetry } from "../src/http.ts";
import { FakeApi } from "./fake-api.ts";
import { captureLogger, tempDir } from "./helpers.ts";

const TOKEN = "worker-token-for-tests-0123456789-abcdefghij";
let api: FakeApi;
before(async () => {
  api = await new FakeApi(TOKEN).start();
});
after(() => api.stop());

const client = (log = captureLogger().log, token = TOKEN, base?: string) =>
  new ApiClient({ base: base ?? api.base, token, workerId: "w1", timeoutMs: 5_000, uploadTimeoutMs: 5_000, log });

describe("withRetry", () => {
  it("retries retryable failures at most 3 times", async () => {
    let n = 0;
    const fail = async () => {
      n++;
      throw new HttpError(503, "x", true);
    };
    await assert.rejects(withRetry(fail, { what: "t", baseDelayMs: 1 }));
    assert.equal(n, 3);
  });
  it("does not retry a non-retryable failure", async () => {
    let n = 0;
    const fail = async () => {
      n++;
      throw new HttpError(400, "x", false);
    };
    await assert.rejects(withRetry(fail, { what: "t", baseDelayMs: 1 }));
    assert.equal(n, 1);
  });
});

describe("ApiClient against the internal contract", () => {
  it("claims, heartbeats, uploads and reports, with bearer + X-Worker-Id, and never leaks the token", async () => {
    const logs = captureLogger();
    const c = client(logs.log);
    assert.equal(await c.claim(["instant_render"]), null);
    const id = await api.enqueue();
    const job = (await c.claim(["instant_render"])) as { job_id: string; upload: Record<string, string> };
    assert.equal(job.job_id, id);
    assert.deepEqual(api.claims.at(-1), { worker_id: "w1", kinds: ["instant_render"] });
    assert.equal(await c.heartbeat(job.upload.heartbeat as string, 41.6), "continue");
    assert.deepEqual(api.jobs.get(id)?.heartbeats, [42]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await c.put(job.upload.still as string, { bytes: png }, "image/png");
    assert.deepEqual(api.jobs.get(id)?.still, png);
    await assert.rejects(
      c.put(job.upload.still as string, { bytes: Buffer.from("nope") }, "image/png"),
      (e: HttpError) => e.status === 422 && !e.retryable,
    );
    await c.failed(job.upload.failed as string, "x".repeat(600), true);
    assert.equal(api.jobs.get(id)?.failed?.error.length, 500);
    assert.ok(
      api.requests
        .filter((r) => r.path.startsWith("/internal/jobs/j_"))
        .every((r) => r.worker === "w1" && r.auth === `Bearer ${TOKEN}`),
    );
    await assert.rejects(
      client(logs.log, `${TOKEN}-wrong`).claim(["instant_render"]),
      (e: Error) => /401/.test(e.message) && !e.message.includes(TOKEN),
    );
    assert.ok(!logs.text().includes(TOKEN));
  });

  it("reports a lost lease as 'lost' and never retries a claim", async () => {
    const c = client();
    const id = await api.enqueue();
    const job = (await c.claim(["instant_render"])) as { upload: { heartbeat: string } };
    api.lose(id);
    assert.equal(await c.heartbeat(job.upload.heartbeat, 50), "lost");
    api.faults.push({ method: "POST", prefix: "/internal/jobs/claim", status: 503, times: 1 });
    const before = api.requests.length;
    await assert.rejects(c.claim(["instant_render"]), (e: HttpError) => e.status === 503);
    assert.equal(api.requests.slice(before).length, 1, "one try only");
  });

  it("streams a file PUT and retries one 503", async () => {
    const c = client();
    const id = await api.enqueue();
    const job = (await c.claim(["instant_render"])) as { upload: { preview: string } };
    const dir = await tempDir();
    const file = path.join(dir, "p.mp4");
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(300_000, 7)]);
    await writeFile(file, mp4);
    api.faults.push({ method: "PUT", prefix: job.upload.preview, status: 503, times: 1 });
    await c.put(job.upload.preview, { file }, "video/mp4");
    assert.deepEqual(api.jobs.get(id)?.preview, mp4);
  });

  it("only ever sends the token to API_BASE's origin", () => {
    const c = client(undefined, TOKEN, "https://api.example.com/base/");
    assert.equal(c.url("/internal/jobs/j_1/still"), "https://api.example.com/base/internal/jobs/j_1/still");
    assert.throws(() => c.url("https://evil.example/internal/jobs/x/still"));
    assert.throws(() => c.url("//evil.example/internal/x"));
  });
});
