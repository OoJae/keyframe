import { childEnv, run } from "./proc.ts";

// ffmpeg/ffprobe stages. Every output is written with bitexact flags and no metadata, so the same input frames give
// the same bytes (no encoder version string, no creation time).

export type FfOptions = { ffmpeg: string; ffprobe: string; timeoutMs: number; signal?: AbortSignal };

const BASE = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags", "+bitexact"];

function ff(args: string[], o: FfOptions) {
  return run(o.ffmpeg, [...BASE, ...args], { env: childEnv(), timeoutMs: o.timeoutMs, signal: o.signal });
}

/** Remux only (no second encode) so `moov` precedes `mdat` and lands in KFC1 chunk 0. */
export async function remuxFaststart(input: string, output: string, o: FfOptions): Promise<void> {
  await ff(["-i", input, "-map", "0", "-c", "copy", "-movflags", "+faststart", ...BITEXACT, output], o);
}

export type Probe = {
  formatName: string;
  formatDurationS: number;
  sizeBytes: number;
  video: {
    codec: string;
    profile: string | null;
    pixFmt: string;
    width: number;
    height: number;
    rFrameRate: string;
    avgFrameRate: string;
    durationS: number;
    frames: number | null;
  };
  audio: { codec: string; sampleRate: number | null; channels: number | null }[];
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseProbe(json: string): Probe {
  type S = Record<string, unknown>;
  const j = JSON.parse(json) as { format?: S; streams?: S[] };
  const streams = j.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === "video");
  if (videos.length !== 1 || !videos[0])
    throw new Error(`ffprobe: expected exactly one video stream, got ${videos.length}`);
  const v = videos[0];
  const vDur = num(v.duration) ?? num(j.format?.duration);
  if (vDur === null) throw new Error("ffprobe: no duration");
  return {
    formatName: String(j.format?.format_name ?? ""),
    formatDurationS: num(j.format?.duration) ?? vDur,
    sizeBytes: num(j.format?.size) ?? 0,
    video: {
      codec: String(v.codec_name ?? ""),
      profile: typeof v.profile === "string" ? v.profile : null,
      pixFmt: String(v.pix_fmt ?? ""),
      width: num(v.width) ?? 0,
      height: num(v.height) ?? 0,
      rFrameRate: String(v.r_frame_rate ?? ""),
      avgFrameRate: String(v.avg_frame_rate ?? ""),
      durationS: vDur,
      frames: num(v.nb_frames),
    },
    audio: streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => ({ codec: String(s.codec_name ?? ""), sampleRate: num(s.sample_rate), channels: num(s.channels) })),
  };
}

export async function probe(file: string, o: FfOptions): Promise<Probe> {
  const res = await run(o.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    env: childEnv(),
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    maxCaptureBytes: 1024 * 1024,
  });
  return parseProbe(res.stdout);
}

function rational(r: string): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(r);
  if (!m) return num(r);
  const d = Number(m[2]);
  return d === 0 ? null : Number(m[1]) / d;
}

export type Expected = { width: number; height: number; fps: number; durationS: number };

/** Spec assertion (verification.md R2): H.264 yuv420p, exact resolution and fps, duration within ±1 frame. */
export function specIssues(p: Probe, want: Expected): string[] {
  const issues: string[] = [];
  const frame = 1 / want.fps;
  if (!p.formatName.split(",").includes("mp4")) issues.push(`container ${p.formatName}, want mp4`);
  if (p.video.codec !== "h264") issues.push(`codec ${p.video.codec}, want h264`);
  if (p.video.pixFmt !== "yuv420p") issues.push(`pix_fmt ${p.video.pixFmt}, want yuv420p`);
  if (p.video.width !== want.width || p.video.height !== want.height) {
    issues.push(`resolution ${p.video.width}x${p.video.height}, want ${want.width}x${want.height}`);
  }
  const fps = rational(p.video.rFrameRate);
  if (fps === null || Math.abs(fps - want.fps) > 1e-6) issues.push(`fps ${p.video.rFrameRate}, want ${want.fps}`);
  if (Math.abs(p.video.durationS - want.durationS) > frame + 1e-6) {
    issues.push(`video duration ${p.video.durationS}s, want ${want.durationS}s ±1 frame`);
  }
  if (Math.abs(p.formatDurationS - want.durationS) > frame + 1e-6) {
    issues.push(`container duration ${p.formatDurationS}s, want ${want.durationS}s ±1 frame`);
  }
  const frames = Math.round(want.durationS * want.fps);
  if (p.video.frames !== null && Math.abs(p.video.frames - frames) > 1)
    issues.push(`${p.video.frames} frames, want ${frames} ±1`);
  return issues;
}

/** Size of the 540p derivatives: short edge 540, aspect kept (9:16 → 540x960, 1:1 → 540x540, 16:9 → 960x540). */
export function previewSize(width: number, height: number): { width: number; height: number } {
  const k = 540 / Math.min(width, height);
  const even = (x: number) => Math.round((x * k) / 2) * 2;
  return { width: even(width), height: even(height) };
}

/** Watermarked quote-time still: tile over the full-size frame, then downscale to 540p. PNG, no metadata. */
export async function compositeStill(
  frame: string,
  tile: string,
  out: string,
  size: { width: number; height: number },
  o: FfOptions,
) {
  await ff(
    [
      "-i",
      frame,
      "-i",
      tile,
      "-filter_complex",
      `[0:v][1:v]overlay=0:0:format=auto,scale=${size.width}:${size.height}:flags=lanczos,format=rgb24[o]`,
      "-map",
      "[o]",
      "-frames:v",
      "1",
      ...BITEXACT,
      out,
    ],
    o,
  );
}

/** 540p watermarked preview MP4 (faststart). Audio, if any, is kept at a low bitrate. */
export async function makePreview(
  master: string,
  tile: string,
  out: string,
  size: { width: number; height: number },
  crf: number,
  o: FfOptions,
) {
  await ff(
    [
      "-i",
      master,
      "-loop",
      "1",
      "-i",
      tile,
      "-filter_complex",
      `[0:v][1:v]overlay=0:0:format=auto:shortest=1,scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p[v]`,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(crf),
      "-profile:v",
      "high",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      ...BITEXACT,
      out,
    ],
    o,
  );
}

/** Exact frame `index` (0-based) as a PNG; select= avoids any seek rounding. */
export async function extractFrame(input: string, index: number, out: string, o: FfOptions): Promise<void> {
  await ff(
    ["-i", input, "-vf", `select=eq(n\\,${index})`, "-fps_mode", "passthrough", "-frames:v", "1", ...BITEXACT, out],
    o,
  );
}

/** SSIM (All) between two images of the same size, compared in yuv420p. */
export async function ssim(a: string, b: string, o: FfOptions): Promise<number> {
  const res = await run(
    o.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      a,
      "-i",
      b,
      "-lavfi",
      "[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim",
      "-f",
      "null",
      "-",
    ],
    { env: childEnv(), timeoutMs: o.timeoutMs, signal: o.signal },
  );
  const m = /All:([0-9.]+)/.exec(res.stderr);
  if (!m?.[1]) throw new Error("ssim: no score in ffmpeg output");
  return Number(m[1]);
}

/** White-on-black tile → RGBA PNG whose alpha is luma × opacity (the watermark overlay). */
export async function lumaToAlpha(
  input: string,
  out: string,
  size: { width: number; height: number },
  opacity: number,
  o: FfOptions,
) {
  await ff(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=white:s=${size.width}x${size.height}:d=1,format=rgba`,
      "-i",
      input,
      "-filter_complex",
      `[1:v]scale=${size.width}:${size.height},format=gray[m];[0:v][m]alphamerge,colorchannelmixer=aa=${opacity.toFixed(3)},format=rgba[o]`,
      "-map",
      "[o]",
      "-frames:v",
      "1",
      ...BITEXACT,
      out,
    ],
    o,
  );
}

/** Versions and the encoders the pipeline needs (libx264, png, aac). */
export async function capabilities(o: FfOptions): Promise<{ ffmpeg: string; ffprobe: string; missing: string[] }> {
  const v = await run(o.ffmpeg, ["-hide_banner", "-version"], { env: childEnv(), timeoutMs: o.timeoutMs });
  const pv = await run(o.ffprobe, ["-hide_banner", "-version"], { env: childEnv(), timeoutMs: o.timeoutMs });
  const enc = await run(o.ffmpeg, ["-hide_banner", "-encoders"], {
    env: childEnv(),
    timeoutMs: o.timeoutMs,
    maxCaptureBytes: 1024 * 1024,
  });
  const missing = ["libx264", "png", "aac"].filter((e) => !new RegExp(`^\\s*\\S+\\s+${e}\\s`, "m").test(enc.stdout));
  return { ffmpeg: v.stdout.split("\n")[0] ?? "", ffprobe: pv.stdout.split("\n")[0] ?? "", missing };
}
