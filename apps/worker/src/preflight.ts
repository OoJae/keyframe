import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import type { BaseConfig } from "./config.ts";
import { capabilities } from "./ffmpeg.ts";
import { browserPath, HYPERFRAMES_VERSION } from "./hyperframes.ts";
import { isRenderable, type LoadedTemplate, listTemplateIds, loadTemplate } from "./templates.ts";

export type PreflightReport = {
  ok: boolean;
  node: string;
  hyperframes: string;
  browser: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  problems: string[];
  templates: { id: string; version: string; status: string; hash: string }[];
};

/** Everything a render needs, checked once at startup (and by `cli.ts preflight`). Never throws. */
export async function preflight(
  cfg: BaseConfig,
): Promise<{ report: PreflightReport; templates: Map<string, LoadedTemplate> }> {
  const problems: string[] = [];
  const report: PreflightReport = {
    ok: false,
    node: process.version,
    hyperframes: HYPERFRAMES_VERSION,
    browser: null,
    ffmpeg: null,
    ffprobe: null,
    problems,
    templates: [],
  };
  const templates = new Map<string, LoadedTemplate>();

  if (!process.versions.node.startsWith("24.")) problems.push(`node ${process.version}; this worker targets Node 24`);
  try {
    const caps = await capabilities({ ffmpeg: cfg.FFMPEG_PATH, ffprobe: cfg.FFPROBE_PATH, timeoutMs: 15_000 });
    report.ffmpeg = caps.ffmpeg;
    report.ffprobe = caps.ffprobe;
    if (caps.missing.length > 0) problems.push(`ffmpeg lacks encoders: ${caps.missing.join(", ")}`);
  } catch (e) {
    problems.push(`ffmpeg/ffprobe unavailable: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    report.browser = await browserPath({ timeoutMs: 120_000 });
  } catch (e) {
    problems.push(`browser: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    await mkdir(cfg.WORK_DIR, { recursive: true });
    await access(cfg.WORK_DIR, constants.W_OK);
  } catch (e) {
    problems.push(`WORK_DIR not writable: ${(e as Error).message}`);
  }
  try {
    for (const id of await listTemplateIds(cfg.TEMPLATES_DIR)) {
      try {
        const t = await loadTemplate(cfg.TEMPLATES_DIR, id);
        templates.set(id, t);
        report.templates.push({ id, version: t.meta.version, status: t.meta.status, hash: t.hash });
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (![...templates.values()].some((t) => isRenderable(t.meta) && t.meta.status !== "kit")) {
      problems.push("no renderable templates");
    }
    if (!templates.has("_watermark")) problems.push("missing _watermark template");
  } catch (e) {
    problems.push(`TEMPLATES_DIR unreadable: ${(e as Error).message}`);
  }
  report.ok = problems.length === 0;
  return { report, templates };
}
