import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KFC1_CHUNK_PLAINTEXT, parseMp4Header } from "../src/index.js";
import { FIXTURES, readJson } from "./helpers.js";

// Fixtures: scripts/gen-mp4-fixture.sh (ffmpeg, 64x36, 1 s, 30 fps, H.264 + AAC; .m4v = same container).
const faststart = new Uint8Array(readFileSync(path.join(FIXTURES, "faststart.m4v")));
const moovAtEnd = new Uint8Array(readFileSync(path.join(FIXTURES, "moov-at-end.m4v")));
const probe = readJson(path.join(FIXTURES, "faststart.ffprobe.json")) as {
  streams: { width: number; height: number }[];
  format: { duration: string };
};

const moovOffset = (b: Uint8Array) => Buffer.from(b).indexOf("moov") - 4;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe("parseMp4Header", () => {
  it("reads duration and video size of a faststart MP4 (matches ffprobe)", () => {
    expect(parseMp4Header(faststart)).toEqual({
      durationMs: Math.round(Number(probe.format.duration) * 1000),
      width: probe.streams[0]?.width,
      height: probe.streams[0]?.height,
      timescale: expect.any(Number),
    });
    expect(parseMp4Header(faststart)).toMatchObject({ durationMs: 1000, width: 64, height: 36 });
  });

  it("works on a first KFC1 chunk (prefix) and on views with a byte offset", () => {
    const padded = new Uint8Array(faststart.byteLength + 7);
    padded.set(faststart, 7);
    expect(parseMp4Header(padded.subarray(7))).toEqual(parseMp4Header(faststart));
    expect(parseMp4Header(faststart.subarray(0, Math.min(faststart.byteLength, KFC1_CHUNK_PLAINTEXT)))).not.toBeNull();
    // moov complete, mdat cut off: still parseable (this is what a first chunk of a big faststart file looks like)
    const moovEnd = moovOffset(faststart) + new DataView(faststart.buffer).getUint32(moovOffset(faststart));
    expect(parseMp4Header(faststart.subarray(0, moovEnd + 9))).toMatchObject({
      durationMs: 1000,
      width: 64,
      height: 36,
    });
  });

  it("returns null when moov is truncated", () => {
    for (const cut of [0, 7, 8, 40, moovOffset(faststart) + 20, faststart.byteLength - 2400]) {
      if (cut < moovOffset(faststart) + new DataView(faststart.buffer).getUint32(moovOffset(faststart))) {
        expect(parseMp4Header(faststart.subarray(0, cut))).toBeNull();
      }
    }
  });

  it("returns null when moov is not in the leading bytes (no faststart)", () => {
    expect(moovOffset(moovAtEnd)).toBeGreaterThan(moovOffset(faststart));
    expect(parseMp4Header(moovAtEnd.subarray(0, moovOffset(moovAtEnd)))).toBeNull();
    expect(parseMp4Header(moovAtEnd)).toMatchObject({ durationMs: 1000, width: 64, height: 36 }); // full file is fine
  });

  it("returns null for garbage and never throws (fuzz)", () => {
    expect(parseMp4Header(new Uint8Array(0))).toBeNull();
    expect(parseMp4Header(new TextEncoder().encode("not an mp4 at all"))).toBeNull();
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (b) => parseMp4Header(b) === null || true),
      { numRuns: 2000 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: faststart.byteLength - 1 }), fc.integer({ min: 0, max: 255 }), (i, v) => {
        const m = Uint8Array.from(faststart);
        m[i] = v;
        const r = parseMp4Header(m);
        return r === null || (Number.isSafeInteger(r.durationMs) && r.width >= 0 && r.height >= 0);
      }),
      { numRuns: 3000 },
    );
  });

  it.skipIf(!hasFfmpeg)("matches ffprobe on a freshly encoded 1080x1920 faststart file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kf-mp4-"));
    try {
      const out = path.join(dir, "fresh.mp4");
      const enc = spawnSync("ffmpeg", [
        ..."-hide_banner -loglevel error -y -f lavfi -i color=c=black:s=1080x1920:r=30 -t 2.5".split(" "),
        ..."-c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart".split(" "),
        out,
      ]);
      expect(enc.status).toBe(0);
      const pr = JSON.parse(
        spawnSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", out],
          {
            encoding: "utf8",
          },
        ).stdout,
      ) as { streams: { width: number; height: number }[]; format: { duration: string } };
      const h = parseMp4Header(new Uint8Array(readFileSync(out)));
      expect(h).toMatchObject({ width: pr.streams[0]?.width, height: pr.streams[0]?.height });
      expect(Math.abs((h?.durationMs ?? 0) - Number(pr.format.duration) * 1000)).toBeLessThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
