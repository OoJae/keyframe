import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type BaseConfig, loadBaseConfig, loadServiceConfig } from "./config.ts";
import { removeDir, writeFileAtomic } from "./files.ts";
import { check, HYPERFRAMES_VERSION } from "./hyperframes.ts";
import { createLogger, type Logger } from "./log.ts";
import { type Ctx, prepare, renderMaster, renderStill } from "./pipeline.ts";
import { preflight } from "./preflight.ts";
import { sealRoundTrip } from "./seal.ts";
import { RenderWorker } from "./service.ts";
import { stamp } from "./stamp.ts";
import { STUDIO_HELP, studioCmd } from "./studio.ts";
import {
  ASPECT_IDS,
  ASPECTS,
  type Aspect,
  isRenderable,
  jsonSchema,
  type LoadedTemplate,
  listTemplateIds,
  loadTemplate,
  type Template,
  type VariableValues,
  validateValues,
} from "./templates.ts";
import { Tiles } from "./watermark.ts";

const HELP = `keyframe worker

  node src/cli.ts serve                       run the render worker (env: API_BASE, WORKER_TOKEN, see .env.example)
  node src/cli.ts render --template <id> --out <dir> [--vars <file.json>] [--aspect 9:16|1:1|16:9|all]
                         [--duration <s>] [--style <id>] [--seal] [--delivery public|private] [--keep-work]
                                              render without the API: still, master, preview, report.json
                                              (--seal: KFC1 encrypt + decrypt round trip with throwaway keys)
  node src/cli.ts check [--template <id> | --all] [--aspect ...] [--vars <file>] [--extremes] [--no-strict]
                                              stamp and run 'hyperframes check' (lint, runtime, layout, contrast)
  node src/cli.ts stamp --template <id> --out <dir> [--aspect ...] [--duration <s>] [--style <id>] [--vars <file>]
                                              write a job directory (open it with 'hyperframes preview <dir>')
  node src/cli.ts templates [--json]          list templates with their hashes (spec.template.hash)
  node src/cli.ts schema [--write]            print (or write templates/template.schema.json) the template.json schema
  node src/cli.ts preflight                   check node, ffmpeg, browser, templates; exit 1 on problems
${STUDIO_HELP}`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "serve":
        return await serve();
      case "render":
        return await renderCmd(rest);
      case "check":
        return await checkCmd(rest);
      case "stamp":
        return await stampCmd(rest);
      case "templates":
        return await templatesCmd(rest);
      case "schema":
        return await schemaCmd(rest);
      case "preflight":
        return await preflightCmd();
      case "studio":
        return await studioCmd(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
      return 2;
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------- serve

async function serve(): Promise<number> {
  const cfg = loadServiceConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const worker = new RenderWorker(cfg, log);
  let stopping: Promise<void> | null = null;
  const stop = (sig: string) => {
    if (stopping) return;
    log.info({ sig }, "shutdown requested");
    stopping = worker.stop();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  await worker.start();
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (stopping) {
        clearInterval(t);
        void stopping.then(resolve);
      }
    }, 200);
  });
  return worker.status().preflight?.ok === false ? 1 : 0;
}

// ---------------------------------------------------------------- shared helpers

const commonOptions = {
  template: { type: "string" },
  aspect: { type: "string", default: "all" },
  duration: { type: "string" },
  style: { type: "string" },
  vars: { type: "string" },
  out: { type: "string" },
} as const;

function aspectsOf(t: Template, arg: string): Aspect[] {
  const supported = ASPECT_IDS.filter((a) => t.aspects[a]);
  if (arg === "all") return supported;
  const list = arg.split(",").map((s) => s.trim());
  for (const a of list) {
    if (!(supported as string[]).includes(a))
      throw new UsageError(`${t.id} supports ${supported.join(", ")}; got ${a}`);
  }
  return list as Aspect[];
}

function durationOf(t: Template, arg: string | undefined): number {
  if (arg === undefined) return t.durations[0] as number;
  const d = Number(arg);
  if (!t.durations.includes(d)) throw new UsageError(`${t.id} durations are ${t.durations.join("/")}; got ${arg}`);
  return d;
}

async function readVars(t: Template, file: string | undefined): Promise<VariableValues> {
  const raw = file ? (JSON.parse(await readFile(file, "utf8")) as unknown) : {};
  return validateValues(t, raw, true);
}

async function renderableTemplate(cfg: BaseConfig, id: string | undefined): Promise<LoadedTemplate> {
  if (!id) throw new UsageError("--template is required");
  const t = await loadTemplate(cfg.TEMPLATES_DIR, id);
  if (!isRenderable(t.meta) || t.meta.status === "kit") {
    throw new UsageError(`${id} is ${t.meta.status}: there is no design to render yet (see templates/${id}/README.md)`);
  }
  return t;
}

function cliTiles(cfg: BaseConfig, log: Logger): Tiles {
  return new Tiles(
    {
      templatesDir: cfg.TEMPLATES_DIR,
      workDir: cfg.WORK_DIR,
      ff: { ffmpeg: cfg.FFMPEG_PATH, ffprobe: cfg.FFPROBE_PATH, timeoutMs: cfg.FFMPEG_TIMEOUT_MS },
      browserGpu: cfg.BROWSER_GPU,
      snapshotTimeoutMs: cfg.STILL_TIMEOUT_MS,
    },
    log,
  );
}

// ---------------------------------------------------------------- render (local, no API)

async function renderCmd(args: string[]): Promise<number> {
  const { values: o } = parseArgs({
    args,
    options: {
      ...commonOptions,
      seal: { type: "boolean", default: false },
      delivery: { type: "string", default: "public" },
      "quote-id": { type: "string" },
      "keep-work": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!o.out) throw new UsageError("--out is required");
  if (o.delivery !== "public" && o.delivery !== "private") throw new UsageError("--delivery must be public or private");
  const cfg = loadBaseConfig();
  const log = createLogger(cfg.LOG_LEVEL, process.stderr);
  const tpl = await renderableTemplate(cfg, o.template);
  const aspects = aspectsOf(tpl.meta, o.aspect);
  const durationS = durationOf(tpl.meta, o.duration);
  const style = o.style ?? (tpl.meta.styles[0] as string);
  const values = await readVars(tpl.meta, o.vars);
  const tiles = cliTiles(cfg, log);
  const outRoot = path.resolve(o.out);
  const summary: unknown[] = [];
  let failed = false;

  for (const aspect of aspects) {
    const slug = ASPECTS[aspect].slug;
    const outDir = path.join(outRoot, slug);
    const work = path.join(outDir, ".work");
    await removeDir(outDir);
    await mkdir(work, { recursive: true });
    const ctx: Ctx = { cfg, log: log.child({ template: tpl.meta.id, aspect }), tiles };
    const spec = { template: tpl, aspect, durationS, style, values };
    const wall0 = performance.now();
    const stamped = await prepare(ctx, spec, work);
    const t0 = performance.now();
    const still = await renderStill(ctx, stamped, aspect, work);
    const stillWallMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const master = await renderMaster(ctx, stamped, spec, work, still.still.path);
    const masterWallMs = Math.round(performance.now() - t1);

    await rename(still.still.path, path.join(outDir, "still.png"));
    await copyFile(still.raw.path, path.join(outDir, "still.raw.png"));
    await rename(master.master.path, path.join(outDir, "master.mp4"));
    await rename(master.preview.path, path.join(outDir, "preview.mp4"));

    let seal: Awaited<ReturnType<typeof sealRoundTrip>> | null = null;
    if (o.seal) {
      seal = await sealRoundTrip(path.join(outDir, "master.mp4"), master.media, path.join(outDir, "kfc1"), {
        quoteId: o["quote-id"],
        delivery: o.delivery,
      });
      if (!seal.roundTrip || !seal.manifestVerified) failed = true;
    }
    if (master.hero.ok === false) failed = true;

    const report = {
      template: { id: tpl.meta.id, version: tpl.meta.version, hash: tpl.hash, status: tpl.meta.status },
      renderer: master.renderer,
      aspect,
      durationS,
      style,
      values,
      still: {
        file: "still.png",
        sha256: still.still.sha256,
        size: still.still.size,
        width: still.still.width,
        height: still.still.height,
        atMs: still.atMs,
        rawSha256: still.raw.sha256,
      },
      master: {
        file: "master.mp4",
        sha256: master.master.sha256,
        size: master.master.size,
        bitrateKbps: master.bitrateKbps,
      },
      preview: {
        file: "preview.mp4",
        sha256: master.preview.sha256,
        size: master.preview.size,
        width: master.preview.width,
        height: master.preview.height,
      },
      media: master.media,
      mp4Header: master.mp4Header,
      probe: master.probe,
      hero: master.hero,
      seal: seal && { ...seal, manifestPath: path.relative(outDir, seal.manifestPath) },
      captureLine: master.captureLine,
      timingsMs: {
        still: { wall: stillWallMs, snapshot: still.timings.snapshotMs, composite: still.timings.compositeMs },
        master: { wall: masterWallMs, ...master.timings },
        seal: seal && { encrypt: seal.encryptMs, decrypt: seal.decryptMs },
        total: Math.round(performance.now() - wall0),
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        cpus: cpus().length,
        memGiB: Math.round(totalmem() / 2 ** 30),
        node: process.version,
      },
    };
    await writeFileAtomic(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (!o["keep-work"]) await removeDir(work);
    summary.push({
      aspect,
      out: outDir,
      stillMs: stillWallMs,
      renderMs: master.timings.renderMs,
      masterWallMs,
      media: master.media,
      masterSha256: master.master.sha256,
      heroSsim: master.hero.ssim,
      seal: seal && { manifestHash: seal.manifestHash, chunks: seal.chunks, roundTrip: seal.roundTrip },
    });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: !failed, template: `${tpl.meta.id}@${tpl.meta.version}`, results: summary }, null, 2)}\n`,
  );
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- check

/** Worst-case values: every free-text string at its max length in a wide glyph, numbers at their max. */
export function extremeValues(t: Template): VariableValues {
  const out: VariableValues = {};
  for (const v of t.variables) {
    if (v.type === "string") {
      const wide = "W".repeat(v.maxLength);
      const ok = !v.json && (!v.pattern || new RegExp(v.pattern).test(wide));
      out[v.id] = ok ? wide : v.default;
    } else if (v.type === "number") {
      out[v.id] = v.max;
    } else {
      out[v.id] = v.default;
    }
  }
  return out;
}

async function checkCmd(args: string[]): Promise<number> {
  const { values: o } = parseArgs({
    args,
    options: {
      ...commonOptions,
      all: { type: "boolean", default: false },
      extremes: { type: "boolean", default: false },
      "no-strict": { type: "boolean", default: false },
    },
    strict: true,
  });
  const cfg = loadBaseConfig();
  const ids = o.all ? await listTemplateIds(cfg.TEMPLATES_DIR) : [o.template ?? ""];
  const results: unknown[] = [];
  let ok = true;
  await mkdir(cfg.WORK_DIR, { recursive: true });
  const tmpRoot = await mkdtemp(path.join(cfg.WORK_DIR, "check-"));
  try {
    for (const id of ids) {
      const t = o.all ? await loadTemplate(cfg.TEMPLATES_DIR, id) : await renderableTemplate(cfg, id);
      if (!isRenderable(t.meta) || t.meta.status === "kit") {
        results.push({ template: id, skipped: t.meta.status });
        continue;
      }
      const variants: [string, VariableValues][] = [["defaults", await readVars(t.meta, o.vars)]];
      if (o.extremes) variants.push(["extremes", validateValues(t.meta, extremeValues(t.meta))]);
      for (const aspect of aspectsOf(t.meta, o.aspect)) {
        for (const durationS of o.duration ? [durationOf(t.meta, o.duration)] : t.meta.durations) {
          for (const [variant, values] of variants) {
            const dir = path.join(tmpRoot, `${id}-${ASPECTS[aspect].slug}-${durationS}-${variant}`);
            const stamped = await stamp({
              templatesDir: cfg.TEMPLATES_DIR,
              template: t,
              aspect,
              durationS,
              style: o.style ?? (t.meta.styles[0] as string),
              values,
              outDir: dir,
            });
            const t0 = performance.now();
            const r = await check(stamped.dir, {
              strict: !o["no-strict"],
              atTransitions: true,
              timeoutMs: 180_000,
              browserGpu: cfg.BROWSER_GPU,
            });
            ok &&= r.ok;
            results.push({
              template: id,
              aspect,
              durationS,
              variant,
              ok: r.ok,
              ms: Math.round(performance.now() - t0),
              lint: r.lint,
              layout: {
                ...r.layout,
                samples: r.layout.samples?.length,
                transitionSamples: r.layout.transitionSamples?.length,
              },
              contrast: r.contrast,
              findings: r.findings.slice(0, 20),
            });
            process.stderr.write(`${r.ok ? "PASS" : "FAIL"} ${id} ${aspect} ${durationS}s ${variant}\n`);
          }
        }
      }
    }
  } finally {
    await removeDir(tmpRoot);
  }
  process.stdout.write(`${JSON.stringify({ ok, hyperframes: HYPERFRAMES_VERSION, results }, null, 2)}\n`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------- stamp / templates / schema / preflight

async function stampCmd(args: string[]): Promise<number> {
  const { values: o } = parseArgs({ args, options: commonOptions, strict: true });
  if (!o.out) throw new UsageError("--out is required");
  const cfg = loadBaseConfig();
  const t = await renderableTemplate(cfg, o.template);
  const [aspect] = aspectsOf(t.meta, o.aspect === "all" ? (Object.keys(t.meta.aspects)[0] as string) : o.aspect);
  const s = await stamp({
    templatesDir: cfg.TEMPLATES_DIR,
    template: t,
    aspect: aspect as Aspect,
    durationS: durationOf(t.meta, o.duration),
    style: o.style ?? (t.meta.styles[0] as string),
    values: await readVars(t.meta, o.vars),
    outDir: path.resolve(o.out),
  });
  process.stdout.write(
    `${JSON.stringify({ dir: s.dir, width: s.width, height: s.height, durationS: s.durationS, heroTimeS: s.heroTimeS })}\n`,
  );
  return 0;
}

async function templatesCmd(args: string[]): Promise<number> {
  const { values: o } = parseArgs({ args, options: { json: { type: "boolean", default: false } }, strict: true });
  const cfg = loadBaseConfig();
  const rows = [];
  for (const id of await listTemplateIds(cfg.TEMPLATES_DIR)) {
    const t = await loadTemplate(cfg.TEMPLATES_DIR, id);
    rows.push({
      id,
      version: t.meta.version,
      format: t.meta.format,
      status: t.meta.status,
      aspects: Object.keys(t.meta.aspects),
      durations: t.meta.durations,
      hash: t.hash,
    });
  }
  if (o.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else
    for (const r of rows)
      process.stdout.write(`${r.id.padEnd(16)} ${r.version.padEnd(8)} ${r.status.padEnd(16)} ${r.hash}\n`);
  return 0;
}

async function schemaCmd(args: string[]): Promise<number> {
  const { values: o } = parseArgs({ args, options: { write: { type: "boolean", default: false } }, strict: true });
  const text = `${JSON.stringify(jsonSchema(), null, 2)}\n`;
  if (o.write) {
    const file = path.join(loadBaseConfig().TEMPLATES_DIR, "template.schema.json");
    await writeFile(file, text);
    process.stderr.write(`wrote ${file}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

async function preflightCmd(): Promise<number> {
  const { report } = await preflight(loadBaseConfig());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}
