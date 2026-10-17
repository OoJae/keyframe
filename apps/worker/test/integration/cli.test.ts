// Integration: the local CLI (`render --seal`, `check`, refusals). Skips without a browser/ffmpeg.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { loadBaseConfig, WORKER_ROOT } from "../../src/config.ts";
import { preflight } from "../../src/preflight.ts";
import { tempDir } from "../helpers.ts";

const exec = promisify(execFile);
const cli = (args: string[], env: Record<string, string> = {}) =>
  exec(process.execPath, [path.join(WORKER_ROOT, "src/cli.ts"), ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
const { report } = await preflight(loadBaseConfig());

describe("cli (integration)", { skip: report.ok ? false : report.problems.join("; "), timeout: 600_000 }, () => {
  it("render --seal: still, master, preview, report and a byte-exact KFC1 round trip", async () => {
    const out = await tempDir("kfw-cli-");
    const { stdout } = await cli(["render", "--template", "probe", "--aspect", "1:1", "--out", out, "--seal"]);
    const summary = JSON.parse(stdout) as { ok: boolean };
    assert.equal(summary.ok, true);
    const dir = path.join(out, "1x1");
    const r = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
    const master = await readFile(path.join(dir, "master.mp4"));
    const hex = `0x${createHash("sha256").update(master).digest("hex")}`;
    assert.equal(r.master.sha256, hex);
    assert.deepEqual(r.media, { mime: "video/mp4", width: 1080, height: 1080, durationMs: 2000, fps: 30 });
    assert.equal(r.seal.roundTrip, true);
    assert.equal(r.seal.manifestVerified, true);
    assert.equal(r.seal.plaintextSha256, hex);
    assert.equal(r.seal.decryptedSha256, hex);
    assert.deepEqual(r.seal.chunk0Header, { durationMs: 2000, width: 1080, height: 1080, timescale: 1000 });
    const manifest = await readFile(path.join(dir, r.seal.manifestPath), "utf8");
    assert.equal(
      `0x${createHash("sha256").update(manifest).digest("hex")}`,
      r.seal.manifestHash,
      "stored manifest is its own JCS preimage",
    );
    assert.ok(
      !stdout.includes("kChain") && !JSON.stringify(r).match(/k(Chain|Buyer|_chain|_buyer)/i),
      "no keys in outputs",
    );
    assert.ok(r.hero.ok);
  });

  it("refuses to render a template that awaits the builder's design", async () => {
    await assert.rejects(
      cli(["render", "--template", "launch_sting", "--out", await tempDir()]),
      (e: { code: number; stderr: string }) => e.code === 2 && /awaiting-design/.test(e.stderr),
    );
  });
});
