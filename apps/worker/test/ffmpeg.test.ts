import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProbe, previewSize, specIssues } from "../src/ffmpeg.ts";

const probeJson = (over: Record<string, unknown> = {}, fmt: Record<string, unknown> = {}) =>
  JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        profile: "High",
        pix_fmt: "yuv420p",
        width: 1080,
        height: 1920,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        duration: "8.000000",
        nb_frames: "240",
        ...over,
      },
    ],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "8.000000", size: "1000000", ...fmt },
  });
const want = { width: 1080, height: 1920, fps: 30, durationS: 8 };

describe("ffprobe assertion", () => {
  it("passes an exact match", () => assert.deepEqual(specIssues(parseProbe(probeJson()), want), []));
  it("tolerates up to one frame of duration error", () => {
    assert.deepEqual(
      specIssues(parseProbe(probeJson({ duration: "8.033333", nb_frames: "241" }, { duration: "8.033333" })), want),
      [],
    );
    assert.equal(specIssues(parseProbe(probeJson({ duration: "8.070000" }, { duration: "8.07" })), want).length, 2);
  });
  it("flags resolution, fps, codec, pixel format and frame count", () => {
    const issues = specIssues(
      parseProbe(
        probeJson({
          width: 1920,
          height: 1080,
          r_frame_rate: "25/1",
          codec_name: "hevc",
          pix_fmt: "yuv444p",
          nb_frames: "200",
        }),
      ),
      want,
    );
    assert.equal(issues.length, 5);
  });
  it("requires exactly one video stream", () => {
    assert.throws(() => parseProbe(JSON.stringify({ streams: [], format: {} })), /exactly one video stream/);
  });
});

describe("previewSize", () => {
  it("scales the short edge to 540 and keeps even dimensions", () => {
    assert.deepEqual(previewSize(1080, 1920), { width: 540, height: 960 });
    assert.deepEqual(previewSize(1080, 1080), { width: 540, height: 540 });
    assert.deepEqual(previewSize(1920, 1080), { width: 960, height: 540 });
  });
});
