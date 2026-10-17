import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { childEnv, run } from "./proc.ts";

// Thin wrappers over the pinned `hyperframes` CLI (flags checked against hyperframes@0.8.140 `--help` and
// dist/render-*.js). Only lint/check/snapshot/render/browser are ever invoked. Never feedback, publish, cloud,
// lambda, cloudrun or auth: those post or upload to hosted services.

const require = createRequire(import.meta.url);
const PKG_PATH = require.resolve("hyperframes/package.json");
const PKG = require(PKG_PATH) as { version: string; bin: Record<string, string> };

export const HYPERFRAMES_VERSION: string = PKG.version;
export const HYPERFRAMES_BIN = path.join(path.dirname(PKG_PATH), PKG.bin.hyperframes ?? "bin/hyperframes.mjs");

export type BrowserGpu = "auto" | "on" | "off";

type Common = { timeoutMs: number; signal?: AbortSignal; browserGpu?: BrowserGpu };

function gpuArgs(mode: BrowserGpu | undefined): string[] {
  if (mode === "on") return ["--browser-gpu"];
  if (mode === "off") return ["--no-browser-gpu"];
  return [];
}

function hf(args: string[], opts: Common & { onStdoutLine?: (l: string) => void; maxCaptureBytes?: number }) {
  return run(process.execPath, [HYPERFRAMES_BIN, ...args], {
    env: childEnv(),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onStdoutLine: opts.onStdoutLine,
    maxCaptureBytes: opts.maxCaptureBytes,
  });
}

/** PNG of the composition at exactly `atS` seconds (not snapped to a frame). Returns the PNG path. */
export async function snapshot(dir: string, atS: number, outDir: string, opts: Common): Promise<string> {
  await hf(
    [
      "snapshot",
      dir,
      "--at",
      String(atS),
      "--no-end",
      "--describe",
      "false",
      "--output",
      outDir,
      ...gpuArgs(opts.browserGpu),
    ],
    opts,
  );
  const pngs = (await readdir(outDir)).filter((f) => f.startsWith("frame-00-") && f.endsWith(".png"));
  if (pngs.length !== 1 || !pngs[0])
    throw new Error(`snapshot: expected one frame PNG in ${outDir}, found ${pngs.length}`);
  return path.join(outDir, pngs[0]);
}

export type RenderOptions = Common & {
  fps: number;
  crf: number;
  workers: string;
  variablesFile: string;
  output: string;
  onProgress?: (pct: number, stage: string) => void;
};

export type RenderSummary = { durationMs: number; captureLine: string | null };

export async function render(dir: string, opts: RenderOptions): Promise<RenderSummary> {
  let captureLine: string | null = null;
  const res = await hf(
    [
      "render",
      dir,
      "--output",
      opts.output,
      "--format",
      "mp4",
      "--fps",
      String(opts.fps),
      "--crf",
      String(opts.crf),
      "--workers",
      opts.workers,
      "--variables-file",
      opts.variablesFile,
      "--strict-variables",
      "--strict",
      "--no-best-effort",
      ...gpuArgs(opts.browserGpu),
    ],
    {
      ...opts,
      onStdoutLine: (line) => {
        if (line.startsWith("@hf-progress ")) {
          try {
            const p = JSON.parse(line.slice("@hf-progress ".length)) as { pct?: unknown; stage?: unknown };
            if (typeof p.pct === "number") opts.onProgress?.(p.pct, typeof p.stage === "string" ? p.stage : "");
          } catch {
            // Malformed progress lines are ignored.
          }
        } else if (/(beginframe|screenshot|drawelement).*(gpu)/i.test(line)) {
          captureLine = line.trim().slice(0, 300);
        }
      },
    },
  );
  return { durationMs: res.durationMs, captureLine };
}

export type CheckReport = {
  ok: boolean;
  lint: { errorCount: number; warningCount: number };
  layout: { errorCount: number; warningCount: number; samples?: number[]; transitionSamples?: number[] };
  contrast: { errorCount: number; warningCount: number; checked?: number; passed?: number };
  findings: { section: string; severity: string; code: string; message: string }[];
};

/** `hyperframes check --json` (lint + runtime + layout + motion + contrast). `strict` also fails on warnings. */
export async function check(
  dir: string,
  opts: Common & { strict: boolean; atTransitions: boolean },
): Promise<CheckReport> {
  const args = ["check", dir, "--json", ...gpuArgs(opts.browserGpu)];
  if (opts.strict) args.push("--strict");
  if (opts.atTransitions) args.push("--at-transitions");
  let stdout: string;
  try {
    stdout = (await hf(args, { ...opts, maxCaptureBytes: 16 * 1024 * 1024 })).stdout;
  } catch (e) {
    // check exits non-zero when it finds problems; the JSON report is still on stdout.
    const out = (e as { result?: { stdout?: string } }).result?.stdout;
    if (!out?.trim().startsWith("{")) throw e;
    stdout = out;
  }
  type Section = {
    errorCount?: number;
    warningCount?: number;
    findings?: { severity?: string; code?: string; message?: string }[];
  };
  const j = JSON.parse(stdout) as Record<string, unknown> & { ok?: boolean };
  const section = (k: string) => (j[k] ?? {}) as Section & Record<string, unknown>;
  const findings: CheckReport["findings"] = [];
  for (const k of ["lint", "runtime", "layout", "motion", "contrast"]) {
    for (const f of section(k).findings ?? []) {
      findings.push({ section: k, severity: String(f.severity), code: String(f.code), message: String(f.message) });
    }
  }
  const counts = (k: string) => ({
    errorCount: section(k).errorCount ?? 0,
    warningCount: section(k).warningCount ?? 0,
  });
  return {
    ok: j.ok === true,
    lint: counts("lint"),
    layout: {
      ...counts("layout"),
      samples: section("layout").samples as number[] | undefined,
      transitionSamples: section("layout").transitionSamples as number[] | undefined,
    },
    contrast: {
      ...counts("contrast"),
      checked: section("contrast").checked as number | undefined,
      passed: section("contrast").passed as number | undefined,
    },
    findings,
  };
}

/** Path of the browser HyperFrames will use (downloads the pinned chrome-headless-shell if it is missing). */
export async function browserPath(opts: Common): Promise<string> {
  const res = await hf(["browser", "path"], opts);
  const line = res.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!line.startsWith("/"))
    throw new Error(`hyperframes browser path: unexpected output ${JSON.stringify(line.slice(0, 120))}`);
  return line;
}
