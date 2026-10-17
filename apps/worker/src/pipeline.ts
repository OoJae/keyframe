import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BaseConfig } from "./config.ts";
import {
  compositeStill,
  extractFrame,
  type FfOptions,
  makePreview,
  type Probe,
  previewSize,
  probe,
  remuxFaststart,
  specIssues,
  ssim,
} from "./ffmpeg.ts";
import { type Artifact, artifact, pngSize, readHead } from "./files.ts";
import { HYPERFRAMES_VERSION, render, snapshot } from "./hyperframes.ts";
import type { Logger } from "./log.ts";
import { KFC1_CHUNK_PLAINTEXT, type Kfc1Media, type Mp4Header, parseMp4Header } from "./protocol/index.ts";
import { type Stamped, stamp } from "./stamp.ts";
import type { Aspect, LoadedTemplate, VariableValues } from "./templates.ts";
import type { Tiles } from "./watermark.ts";

// The render pipeline, shared by the API-driven service and the local CLI:
//   stamp → (still) snapshot at heroTime → watermark composite → 540p PNG
//         → (master) hyperframes render → faststart remux → ffprobe assertion → MP4 header check on KFC1 chunk 0
//           → 540p watermarked preview → hero-frame self-check against the approved still (SSIM, logged).
// No stage holds keys: KFC1 sealing is the API's job (frozen-interfaces §4).

export type Stage =
  | "stamp"
  | "assets"
  | "snapshot"
  | "composite"
  | "render"
  | "remux"
  | "probe"
  | "preview"
  | "hero"
  | "upload";

export type Ctx = {
  cfg: BaseConfig;
  log: Logger;
  tiles: Tiles;
  signal?: AbortSignal;
  onStage?: (stage: Stage, pct: number) => void;
};

export type RenderSpec = {
  template: LoadedTemplate;
  aspect: Aspect;
  durationS: number;
  style: string;
  values: VariableValues;
};

export class PipelineError extends Error {
  override name = "PipelineError";
  readonly code: "spec_mismatch" | "not_faststart" | "bad_snapshot";
  constructor(code: PipelineError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const ms = (t0: number) => Math.round(performance.now() - t0);

function ffOpts(ctx: Ctx, timeoutMs = ctx.cfg.FFMPEG_TIMEOUT_MS): FfOptions {
  return { ffmpeg: ctx.cfg.FFMPEG_PATH, ffprobe: ctx.cfg.FFPROBE_PATH, timeoutMs, signal: ctx.signal };
}

export async function prepare(ctx: Ctx, spec: RenderSpec, workDir: string): Promise<Stamped> {
  ctx.onStage?.("stamp", 0);
  return stamp({
    templatesDir: ctx.cfg.TEMPLATES_DIR,
    template: spec.template,
    aspect: spec.aspect,
    durationS: spec.durationS,
    style: spec.style,
    values: spec.values,
    outDir: path.join(workDir, "comp"),
  });
}

export type StillResult = {
  /** Watermarked 540p PNG: the bytes served as the quote preview; its sha256 is spec.keyframe.stillSha256. */
  still: Artifact & { width: number; height: number };
  /** Full-size unwatermarked snapshot (private; kept for self-checks). */
  raw: Artifact;
  atMs: number;
  timings: { snapshotMs: number; compositeMs: number };
};

export async function renderStill(ctx: Ctx, stamped: Stamped, aspect: Aspect, workDir: string): Promise<StillResult> {
  ctx.onStage?.("snapshot", 10);
  let t0 = performance.now();
  const rawPath = await snapshot(stamped.dir, stamped.heroTimeS, path.join(workDir, "snap"), {
    timeoutMs: ctx.cfg.STILL_TIMEOUT_MS,
    signal: ctx.signal,
    browserGpu: ctx.cfg.BROWSER_GPU,
  });
  const snapshotMs = ms(t0);
  const size = await pngSize(rawPath);
  if (size.width !== stamped.width || size.height !== stamped.height) {
    throw new PipelineError(
      "bad_snapshot",
      `snapshot is ${size.width}x${size.height}, want ${stamped.width}x${stamped.height}`,
    );
  }

  ctx.onStage?.("composite", 60);
  t0 = performance.now();
  const tile = await ctx.tiles.get(aspect);
  const outSize = previewSize(stamped.width, stamped.height);
  const stillPath = path.join(workDir, "still.png");
  await compositeStill(rawPath, tile, stillPath, outSize, ffOpts(ctx));
  const compositeMs = ms(t0);

  return {
    still: { ...(await artifact(stillPath)), ...outSize },
    raw: await artifact(rawPath),
    atMs: Math.round(stamped.heroTimeS * 1000),
    timings: { snapshotMs, compositeMs },
  };
}

export type MasterResult = {
  master: Artifact;
  preview: Artifact & { width: number; height: number };
  /** Exactly the KFC1 manifest `media` object (frozen-interfaces §5). */
  media: Kfc1Media;
  probe: Probe;
  mp4Header: Mp4Header;
  bitrateKbps: number;
  hero: { frame: number; ssim: number | null; ok: boolean | null };
  renderer: { name: "hyperframes"; version: string };
  captureLine: string | null;
  timings: { renderMs: number; remuxMs: number; probeMs: number; previewMs: number; heroMs: number };
};

/**
 * Render the master and its derivatives. `approvedStill` is the watermarked still the buyer approved (if known);
 * the master's hero frame is composited the same way and compared with SSIM. A low score is reported, not thrown:
 * it is a logged self-check, not a trust boundary (product-render-demo B4).
 */
export async function renderMaster(
  ctx: Ctx,
  stamped: Stamped,
  spec: RenderSpec,
  workDir: string,
  approvedStill?: string,
): Promise<MasterResult> {
  const budgetMs = Math.max(ctx.cfg.RENDER_TIMEOUT_MS, spec.template.meta.perf.renderBudgetS * 4 * 1000);
  ctx.onStage?.("render", 0);
  let t0 = performance.now();
  const rawPath = path.join(workDir, "raw.mp4");
  const summary = await render(stamped.dir, {
    fps: stamped.fps,
    crf: ctx.cfg.RENDER_CRF,
    workers: ctx.cfg.RENDER_WORKERS,
    variablesFile: stamped.varsPath,
    output: rawPath,
    timeoutMs: budgetMs,
    signal: ctx.signal,
    browserGpu: ctx.cfg.BROWSER_GPU,
    onProgress: (pct) => ctx.onStage?.("render", Math.min(99, pct)),
  });
  const renderMs = ms(t0);
  if (renderMs > spec.template.meta.perf.renderBudgetS * 1000) {
    ctx.log.warn({ renderMs, budgetS: spec.template.meta.perf.renderBudgetS }, "render over perf budget");
  }

  ctx.onStage?.("remux", 0);
  t0 = performance.now();
  const masterPath = path.join(workDir, "master.mp4");
  await remuxFaststart(rawPath, masterPath, ffOpts(ctx));
  const remuxMs = ms(t0);

  ctx.onStage?.("probe", 0);
  t0 = performance.now();
  const p = await probe(masterPath, ffOpts(ctx));
  const want = { width: stamped.width, height: stamped.height, fps: stamped.fps, durationS: stamped.durationS };
  const issues = specIssues(p, want);
  if (issues.length > 0)
    throw new PipelineError("spec_mismatch", `master does not match the spec: ${issues.join("; ")}`);
  // The plugin decrypts chunk 0 and reads the header from it; prove that works on these exact bytes.
  const header = parseMp4Header(await readHead(masterPath, KFC1_CHUNK_PLAINTEXT));
  if (!header) throw new PipelineError("not_faststart", "moov is not inside the first KFC1 chunk");
  const frameMs = 1000 / stamped.fps;
  if (
    header.width !== want.width ||
    header.height !== want.height ||
    Math.abs(header.durationMs - want.durationS * 1000) > frameMs + 1
  ) {
    throw new PipelineError("spec_mismatch", `MP4 header ${JSON.stringify(header)} does not match the spec`);
  }
  const probeMs = ms(t0);
  const master = await artifact(masterPath);
  const bitrateKbps = Math.round((master.size * 8) / p.formatDurationS / 1000);

  ctx.onStage?.("preview", 0);
  t0 = performance.now();
  const tile = await ctx.tiles.get(spec.aspect);
  const pSize = previewSize(stamped.width, stamped.height);
  const previewPath = path.join(workDir, "preview.mp4");
  await makePreview(masterPath, tile, previewPath, pSize, ctx.cfg.PREVIEW_CRF, ffOpts(ctx));
  const previewMs = ms(t0);

  ctx.onStage?.("hero", 0);
  t0 = performance.now();
  const heroFrame = Math.round(stamped.heroTimeS * stamped.fps);
  let heroSsim: number | null = null;
  if (approvedStill) {
    const heroDir = path.join(workDir, "hero");
    await mkdir(heroDir, { recursive: true });
    const full = path.join(heroDir, "frame.png");
    const composited = path.join(heroDir, "frame.still.png");
    await extractFrame(masterPath, heroFrame, full, ffOpts(ctx));
    await compositeStill(full, tile, composited, pSize, ffOpts(ctx));
    heroSsim = await ssim(composited, approvedStill, ffOpts(ctx));
    if (heroSsim < ctx.cfg.HERO_SSIM_MIN) {
      ctx.log.warn({ heroSsim, min: ctx.cfg.HERO_SSIM_MIN }, "master hero frame differs from the approved still");
    }
  }
  const heroMs = ms(t0);

  return {
    master,
    preview: { ...(await artifact(previewPath)), ...pSize },
    media: {
      mime: "video/mp4",
      width: header.width,
      height: header.height,
      durationMs: header.durationMs,
      fps: stamped.fps,
    },
    probe: p,
    mp4Header: header,
    bitrateKbps,
    hero: { frame: heroFrame, ssim: heroSsim, ok: heroSsim === null ? null : heroSsim >= ctx.cfg.HERO_SSIM_MIN },
    renderer: { name: "hyperframes", version: HYPERFRAMES_VERSION },
    captureLine: summary.captureLine,
    timings: { renderMs, remuxMs, probeMs, previewMs, heroMs },
  };
}
