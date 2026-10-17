import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "./api.ts";
import type { ServiceConfig } from "./config.ts";
import { removeDir } from "./files.ts";
import { type HealthServer, startHealthServer } from "./health.ts";
import { HttpError, sleep } from "./http.ts";
import { HYPERFRAMES_VERSION } from "./hyperframes.ts";
import { type FailureCode, type JobInputs, JobInputsSchema, JobRefSchema } from "./jobs.ts";
import { sealFile } from "./kfc1.ts";
import type { Logger } from "./log.ts";
import {
  type Ctx,
  PipelineError,
  prepare,
  type RenderSpec,
  renderMaster,
  renderStill,
  type Stage,
} from "./pipeline.ts";
import { type PreflightReport, preflight } from "./preflight.ts";
import { ProcError } from "./proc.ts";
import { ASPECT_IDS, heroTimeOf, isRenderable, type LoadedTemplate, TemplateError } from "./templates.ts";
import { hasMapper, toTemplateVars } from "./vars.ts";
import { Tiles } from "./watermark.ts";

// The render worker service. It claims `instant_render` jobs from the API, and for each one:
//   stamp → still (snapshot at the hero time + watermark) → PUT still (the quote shows its key frame early)
//   → master (render, faststart remux, ffprobe and MP4 header assertions) → 540p preview → PUT preview
//   → KFC1-seal the master with the job's K_file → PUT manifest, then every chunk → POST done
// It renews the lease with heartbeats throughout. Any failure is POSTed to `failed` with `retryable`, and the API
// enforces max_attempts (3) and cancels the quote when a job finally fails. The job directory is always removed.

export const WORKER_VERSION = "0.1.0";
const KINDS = ["instant_render"] as const;

class Abort extends Error {
  override name = "Abort";
  readonly code: "lost" | "timeout" | "shutdown";
  constructor(code: Abort["code"]) {
    super(code);
    this.code = code;
  }
}

class JobFailure extends Error {
  override name = "JobFailure";
  readonly code: FailureCode;
  readonly retryable: boolean;
  constructor(code: FailureCode, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

type Active = { job: JobInputs; abort: AbortController; stage: Stage | "seal"; pct: number };

export type WorkerStatus = {
  status: "starting" | "ready" | "degraded" | "draining" | "stopped";
  worker_id: string;
  version: string;
  renderer: { name: string; version: string };
  uptime_s: number;
  lanes: { max: number; busy: number };
  templates: { id: string; version: string; hash: string }[];
  jobs: {
    done: number;
    failed: number;
    lost: number;
    active: { job_id: string; quote_id: string; stage: string; pct: number }[];
  };
  api: { last_ok_at: string | null; consecutive_failures: number };
  preflight: { ok: boolean; problems: string[] } | null;
};

export class RenderWorker {
  private readonly cfg: ServiceConfig;
  private readonly log: Logger;
  private readonly api: ApiClient;
  private readonly tiles: Tiles;
  private readonly lanes: { max: number; busy: number };
  private readonly active = new Map<string, Active>();
  private templates = new Map<string, LoadedTemplate>();
  private pre: PreflightReport | null = null;
  private phase: WorkerStatus["status"] = "starting";
  private readonly startedAt = Date.now();
  private readonly stats = { done: 0, failed: 0, lost: 0 };
  private lastApiOk: number | null = null;
  private apiFailures = 0;
  private readonly stopping = new AbortController();
  private loop: Promise<void> | null = null;
  private health: HealthServer | null = null;

  constructor(cfg: ServiceConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log;
    this.api = new ApiClient({
      base: cfg.API_BASE,
      token: cfg.WORKER_TOKEN,
      workerId: cfg.WORKER_ID,
      timeoutMs: cfg.HTTP_TIMEOUT_MS,
      uploadTimeoutMs: cfg.UPLOAD_TIMEOUT_MS,
      log,
    });
    this.tiles = new Tiles(
      {
        templatesDir: cfg.TEMPLATES_DIR,
        workDir: cfg.WORK_DIR,
        ff: { ffmpeg: cfg.FFMPEG_PATH, ffprobe: cfg.FFPROBE_PATH, timeoutMs: cfg.FFMPEG_TIMEOUT_MS },
        browserGpu: cfg.BROWSER_GPU,
        snapshotTimeoutMs: cfg.STILL_TIMEOUT_MS,
      },
      log,
    );
    this.lanes = { max: cfg.RENDER_LANES, busy: 0 };
  }

  get healthPort(): number | null {
    return this.health?.port ?? null;
  }

  status(): WorkerStatus {
    return {
      status: this.phase,
      worker_id: this.cfg.WORKER_ID,
      version: WORKER_VERSION,
      renderer: { name: "hyperframes", version: HYPERFRAMES_VERSION },
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      lanes: { ...this.lanes },
      templates: this.renderable().map((t) => ({ id: t.meta.id, version: t.meta.version, hash: t.hash })),
      jobs: {
        ...this.stats,
        active: [...this.active.values()].map((a) => ({
          job_id: a.job.job_id,
          quote_id: a.job.quote_id,
          stage: a.stage,
          pct: a.pct,
        })),
      },
      api: {
        last_ok_at: this.lastApiOk ? new Date(this.lastApiOk).toISOString() : null,
        consecutive_failures: this.apiFailures,
      },
      preflight: this.pre ? { ok: this.pre.ok, problems: this.pre.problems } : null,
    };
  }

  /** Ready = preflight passed, not draining, and the API is answering (or a job is in flight). */
  ready(): boolean {
    return this.phase === "ready" && this.apiFailures < 5 && (this.lastApiOk !== null || this.active.size > 0);
  }

  private renderable(): LoadedTemplate[] {
    return [...this.templates.values()].filter(
      (t) => isRenderable(t.meta) && t.meta.status !== "kit" && hasMapper(t.meta.id),
    );
  }

  async start(): Promise<void> {
    this.health = await startHealthServer(this.cfg.HEALTH_HOST, this.cfg.HEALTH_PORT, this, this.log);
    // Leftover job directories belong to leases that have lapsed by now.
    await removeDir(path.join(this.cfg.WORK_DIR, "jobs"));
    const { report, templates } = await preflight(this.cfg);
    this.pre = report;
    this.templates = templates;
    if (!report.ok) {
      this.phase = "degraded";
      this.log.error({ problems: report.problems }, "preflight failed; not claiming jobs");
      return;
    }
    // Warm the watermark tiles so the first quote-time still is not slowed down by them.
    for (const a of ASPECT_IDS) await this.tiles.get(a);
    this.phase = "ready";
    this.log.info(
      {
        templates: this.renderable().map((t) => `${t.meta.id}@${t.meta.version} ${t.hash}`),
        browser: report.browser,
        hyperframes: report.hyperframes,
      },
      "worker ready",
    );
    this.loop = this.pollLoop();
  }

  /** Stop claiming, let active jobs finish (up to DRAIN_TIMEOUT_MS), then abort the rest as retryable. */
  async stop(): Promise<void> {
    if (this.phase === "stopped" || this.phase === "draining") return;
    this.phase = "draining";
    this.log.info({ active: this.active.size }, "draining");
    const deadline = Date.now() + this.cfg.DRAIN_TIMEOUT_MS;
    while (this.active.size > 0 && Date.now() < deadline) await sleep(250);
    for (const a of this.active.values()) a.abort.abort(new Abort("shutdown"));
    while (this.active.size > 0) await sleep(100);
    this.stopping.abort();
    await this.loop?.catch(() => undefined);
    await this.health?.close();
    this.phase = "stopped";
    this.log.info(this.stats, "stopped");
  }

  private apiOk(): void {
    this.lastApiOk = Date.now();
    this.apiFailures = 0;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      if (this.phase !== "ready" || this.lanes.busy >= this.lanes.max) {
        await sleep(this.cfg.POLL_INTERVAL_MS, this.stopping.signal).catch(() => undefined);
        continue;
      }
      try {
        const raw = await this.api.claim([...KINDS], this.stopping.signal);
        this.apiOk();
        if (raw === null) {
          await sleep(this.cfg.POLL_INTERVAL_MS, this.stopping.signal).catch(() => undefined);
          continue;
        }
        this.launch(raw);
      } catch (e) {
        if (this.stopping.signal.aborted) break;
        this.apiFailures++;
        this.log.warn({ err: (e as Error).message, failures: this.apiFailures }, "claim failed");
        const backoff = Math.min(30_000, this.cfg.POLL_INTERVAL_MS * 2 ** Math.min(this.apiFailures, 4));
        await sleep(backoff, this.stopping.signal).catch(() => undefined);
      }
    }
  }

  private launch(raw: unknown): void {
    const parsed = JobInputsSchema.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      const ref = JobRefSchema.safeParse(raw);
      this.log.error({ job_id: ref.success ? ref.data.job_id : null, err: msg }, "invalid job inputs");
      if (ref.success)
        void this.reportFailed(ref.data.upload.failed, { code: "bad_job", message: msg, retryable: false });
      return;
    }
    this.lanes.busy++;
    void this.runJob(parsed.data).finally(() => {
      this.lanes.busy--;
    });
  }

  private jobTimeoutMs(t: LoadedTemplate): number {
    const c = this.cfg;
    const render = Math.max(c.RENDER_TIMEOUT_MS, t.meta.perf.renderBudgetS * 4000);
    return c.STILL_TIMEOUT_MS * 2 + render + c.FFMPEG_TIMEOUT_MS * 4 + c.UPLOAD_TIMEOUT_MS * 3;
  }

  private async runJob(job: JobInputs): Promise<void> {
    const log = this.log.child({ job_id: job.job_id, quote_id: job.quote_id, attempt: job.attempt });
    const abort = new AbortController();
    const entry: Active = { job, abort, stage: "stamp", pct: 0 };
    this.active.set(job.job_id, entry);
    const jobDir = path.join(this.cfg.WORK_DIR, "jobs", `${job.job_id}-${job.attempt}`);
    let renew: NodeJS.Timeout | undefined;
    let hard: NodeJS.Timeout | undefined;
    const progress = (stage: Active["stage"], pct: number) => {
      entry.stage = stage;
      entry.pct = pct;
    };
    try {
      if (job.kind !== "instant_render" || !job.template) {
        throw new JobFailure("bad_job", `this worker renders instant_render jobs, not ${job.kind}`, false);
      }
      const jobTemplate = job.template;
      const template = this.resolveTemplate(jobTemplate.id);
      log.info(
        {
          template: `${template.meta.id}@${template.meta.version}`,
          aspect: job.output.aspect,
          duration_s: job.output.duration_s,
        },
        "job start",
      );
      const values = await this.mapVariables(template, job);
      this.checkOutput(template, job, log);

      renew = setInterval(() => {
        this.api
          .heartbeat(job.upload.heartbeat, entry.pct)
          .then((r) => {
            this.apiOk();
            if (r === "lost") abort.abort(new Abort("lost"));
          })
          .catch((e) => log.warn({ err: (e as Error).message }, "heartbeat failed"));
      }, this.cfg.HEARTBEAT_INTERVAL_MS);
      hard = setTimeout(() => abort.abort(new Abort("timeout")), this.jobTimeoutMs(template));

      const ctx: Ctx = { cfg: this.cfg, log, tiles: this.tiles, signal: abort.signal };
      const spec: RenderSpec = {
        template,
        aspect: job.output.aspect,
        durationS: job.output.duration_s,
        style: jobTemplate.style,
        values,
      };
      await mkdir(jobDir, { recursive: true });
      const t0 = performance.now();

      progress("stamp", 2);
      const stamped = await prepare(ctx, spec, jobDir);
      progress("snapshot", 5);
      const still = await renderStill(ctx, stamped, spec.aspect, jobDir);
      progress("upload", 10);
      await this.upload("still", () =>
        this.api.put(job.upload.still, { file: still.still.path }, "image/png", abort.signal),
      );
      log.info({ ms: Math.round(performance.now() - t0), sha256: still.still.sha256 }, "still uploaded");

      ctx.onStage = (stage, pct) =>
        progress(stage, stage === "render" ? 12 + Math.round(pct * 0.6) : Math.max(entry.pct, 75));
      const master = await renderMaster(ctx, stamped, spec, jobDir, still.still.path);
      progress("upload", 80);
      await this.upload("preview", () =>
        this.api.put(job.upload.preview, { file: master.preview.path }, "video/mp4", abort.signal),
      );

      progress("seal", 85);
      const sealed = await sealFile(
        master.master.path,
        job.kfc1.k_file as `0x${string}`,
        job.kfc1.salt as `0x${string}`,
        master.media,
      );
      if (sealed.manifest.plaintextSha256 !== master.master.sha256) {
        throw new JobFailure("internal", "sealed bytes differ from the rendered master", true);
      }
      await this.upload("manifest", () =>
        this.api.putManifest(job.upload.manifest, sealed.manifest, sealed.manifestHash, abort.signal),
      );
      for (const [i, chunk] of sealed.chunks.entries()) {
        progress("upload", 88 + Math.round((10 * (i + 1)) / sealed.chunks.length));
        const target = job.upload.chunk.replace("{i}", String(i));
        await this.upload(`chunk ${i}`, () =>
          this.api.put(target, { bytes: chunk }, "application/octet-stream", abort.signal),
        );
      }
      if (abort.signal.aborted) throw abort.signal.reason;

      const body = {
        template: { id: jobTemplate.id, version: template.meta.version, hash: template.hash },
        renderer: master.renderer,
        keyframe_at_ms: still.atMs,
      };
      try {
        await this.api.done(job.upload.done, body, abort.signal);
      } catch (e) {
        // A retried `done` whose first try landed answers 409 (job already completed): nothing more to do.
        if (!(e instanceof HttpError && e.status === 409)) throw e;
        log.warn({ err: e.message }, "done answered 409; treating the job as handed over");
      }
      this.apiOk();
      this.stats.done++;
      log.info(
        {
          ms: Math.round(performance.now() - t0),
          manifest_hash: sealed.manifestHash,
          chunks: sealed.chunks.length,
          master_sha256: master.master.sha256,
          hero_ssim: master.hero.ssim,
          render_ms: master.timings.renderMs,
        },
        "job done",
      );
    } catch (e) {
      const f = this.classify(e, abort.signal, entry.stage);
      if (f.code === "cancelled") {
        this.stats.lost++;
        log.warn("job no longer held by this worker; stopped");
      } else {
        this.stats.failed++;
        log.error({ code: f.code, retryable: f.retryable, stage: entry.stage, err: f.message }, "job failed");
        await this.reportFailed(job.upload.failed, f);
      }
    } finally {
      clearInterval(renew);
      clearTimeout(hard);
      if (!this.cfg.KEEP_JOBS)
        await removeDir(jobDir).catch((e) => log.warn({ err: (e as Error).message }, "cleanup failed"));
      this.active.delete(job.job_id);
    }
  }

  /** The API names templates by catalog id (hyphens allowed); template directories use underscores. */
  private resolveTemplate(id: string): LoadedTemplate {
    const t = this.templates.get(id) ?? this.templates.get(id.replace(/-/g, "_"));
    if (!t || !isRenderable(t.meta) || t.meta.status === "kit" || !hasMapper(t.meta.id)) {
      throw new JobFailure("bad_template", `template ${id} is not renderable here (awaiting design or unknown)`, false);
    }
    return t;
  }

  private async mapVariables(t: LoadedTemplate, job: JobInputs) {
    try {
      return await toTemplateVars(this.cfg.TEMPLATES_DIR, t.meta, {
        params: job.params,
        quoteId: job.quote_id,
        // Prefer the quote-time anchor committed in the spec (params.as_of); fall back to now for older quotes.
        anchorS: anchorOf(job.params),
      });
    } catch (e) {
      if (e instanceof TemplateError) throw new JobFailure("bad_variables", e.message, false);
      throw e;
    }
  }

  /** The job's output spec must agree with template.json; hero-time disagreements are logged, the template wins. */
  private checkOutput(t: LoadedTemplate, job: JobInputs, log: Logger): void {
    const o = job.output;
    const size = t.meta.aspects[o.aspect];
    const problems: string[] = [];
    if (!size) problems.push(`aspect ${o.aspect}`);
    else if (size.width !== o.width || size.height !== o.height) problems.push(`size ${o.width}x${o.height}`);
    if (!t.meta.durations.includes(o.duration_s)) problems.push(`duration ${o.duration_s}s`);
    if (t.meta.fps !== o.fps) problems.push(`fps ${o.fps}`);
    if (job.template && !t.meta.styles.includes(job.template.style)) problems.push(`style ${job.template.style}`);
    if (problems.length > 0)
      throw new JobFailure("bad_template", `${t.meta.id} cannot produce ${problems.join(", ")}`, false);
    const heroMs = Math.round(heroTimeOf(t.meta, o.duration_s) * 1000);
    if (heroMs !== o.hero_ms)
      log.warn({ api: o.hero_ms, template: heroMs }, "hero time differs from the API catalog; using the template's");
  }

  private async upload<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      this.apiOk();
      return r;
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 409 || e.status === 403) throw new Abort("lost");
        if (e.status !== null && e.status >= 400 && e.status < 500)
          throw new JobFailure("upload_rejected", `${what}: ${e.message}`, false);
        throw new JobFailure("upload_failed", `${what}: ${e.message}`, true);
      }
      throw e;
    }
  }

  private classify(
    e: unknown,
    signal: AbortSignal,
    stage: string,
  ): { code: FailureCode; message: string; retryable: boolean } {
    const reason = signal.aborted ? signal.reason : e instanceof Abort ? e : null;
    if (reason instanceof Abort) {
      if (reason.code === "lost") return { code: "cancelled", message: "job lost", retryable: true };
      return { code: reason.code, message: `${reason.code} during ${stage}`, retryable: true };
    }
    if (e instanceof JobFailure) return { code: e.code, message: clip(e.message), retryable: e.retryable };
    if (e instanceof TemplateError) {
      return {
        code: e.code === "bad_variables" ? "bad_variables" : "bad_template",
        message: clip(e.message),
        retryable: false,
      };
    }
    if (e instanceof PipelineError) return { code: "spec_mismatch", message: clip(e.message), retryable: false };
    if (e instanceof ProcError) {
      return { code: e.kind === "timeout" ? "timeout" : "render_failed", message: clip(e.message), retryable: true };
    }
    return { code: "internal", message: clip((e as Error)?.message ?? String(e)), retryable: true };
  }

  private async reportFailed(p: string, f: { code: FailureCode; message: string; retryable: boolean }): Promise<void> {
    try {
      await this.api.failed(p, `${f.code}: ${f.message}`, f.retryable);
      this.apiOk();
    } catch (e) {
      // The lease will lapse and the API will re-queue or cancel; nothing else to do.
      this.log.error({ err: (e as Error).message }, "could not report failure");
    }
  }
}

const clip = (s: string) => (s.length > 450 ? `${s.slice(0, 447)}...` : s);

/** Quote-time anchor (seconds) from spec params.as_of, else the current time. */
function anchorOf(params: Record<string, unknown> | undefined): number {
  const asOf = params && typeof params.as_of === "string" ? Date.parse(params.as_of) : Number.NaN;
  return Number.isFinite(asOf) ? Math.floor(asOf / 1000) : Math.floor(Date.now() / 1000);
}
