import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBaseConfig } from "../../src/config.ts";
import { prepareMaster, StudioError } from "../../src/studio.ts";
import { tempDir } from "../helpers.ts";

// The Studio CLI's gate before anything is uploaded: a hand-made master is remuxed (no re-encode) and held to the
// order's output spec. Uses the 10 s 9:16 fixture the API's e2e delivers.
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../api/test/fixtures/studio-10s-9x16.m4v",
);
const cfg = loadBaseConfig({});
const ff = { ffmpeg: cfg.FFMPEG_PATH, ffprobe: cfg.FFPROBE_PATH, timeoutMs: cfg.FFMPEG_TIMEOUT_MS };

describe("studio prepareMaster", () => {
  it("accepts a master that matches the order's spec and returns the KFC1 media", async () => {
    const dir = await tempDir();
    const m = await prepareMaster(
      FIXTURE,
      dir,
      { aspect: "9:16", width: 1080, height: 1920, durationS: 10, fps: 30 },
      ff,
    );
    assert.deepEqual(m.media, { mime: "video/mp4", width: 1080, height: 1920, durationMs: 10_000, fps: 30 });
    assert.match(m.artifact.sha256, /^0x[0-9a-f]{64}$/);
  });

  it("refuses a master for another aspect or duration, listing every mismatch", async () => {
    const dir = await tempDir();
    await assert.rejects(
      prepareMaster(FIXTURE, dir, { aspect: "16:9", width: 1920, height: 1080, durationS: 8, fps: 30 }, ff),
      (e: unknown) =>
        e instanceof StudioError && /resolution 1080x1920, want 1920x1080/.test(e.message) && /want 8s/.test(e.message),
    );
  });
});
