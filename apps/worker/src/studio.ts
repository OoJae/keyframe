import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ApiClient } from "./api.ts";
import { type BaseConfig, loadBaseConfig, loadServiceConfig } from "./config.ts";
import { type FfOptions, makePreview, previewSize, probe, remuxFaststart, specIssues } from "./ffmpeg.ts";
import { artifact, readHead, removeDir } from "./files.ts";
import { request } from "./http.ts";
import { JobInputsSchema } from "./jobs.ts";
import { type Sealed, sealFile } from "./kfc1.ts";
import { createLogger, type Logger } from "./log.ts";
import { KFC1_CHUNK_PLAINTEXT, parseMp4Header } from "./protocol/index.ts";
import { sealRoundTrip } from "./seal.ts";
import { ASPECTS, type Aspect } from "./templates.ts";
import { Tiles } from "./watermark.ts";

// `studio`: the designer's side of a Studio (hand-made) commission, over the API's /internal/studio routes.
//   inbox                       paid Studio orders, their brief, output spec and deadline
//   check <file> --aspect --duration [--fps]
//                               local dry run: spec check, watermarked preview, KFC1 seal round trip (no API)
//   deliver <order_id> <file>   the same checks against the order's own spec, then upload the watermarked review
//                               preview and the master sealed with the order's key; the API relays
//                               deliver(T, manifestHash) on Base and the buyer reviews (accept / one change / reject)
//   cancel <order_id> --yes     void the order: the buyer gets everything back
// A master that fails the spec is never uploaded. Re-running deliver re-opens the same delivery job (24 h lease).

export const STUDIO_HELP = `  node src/cli.ts studio inbox                list paid Studio orders (brief, spec, deadline)
  node src/cli.ts studio check <file.mp4> --aspect 9:16|1:1|16:9 --duration <s> [--fps 30]
                                              check a master locally: spec, watermarked preview, KFC1 round trip
  node src/cli.ts studio deliver <order_id> <file.mp4> [--keep-work]
                                              deliver a finished master for the buyer's review
  node src/cli.ts studio cancel <order_id> --yes
                                              void a Studio order; the buyer is refunded in full
`;

type Output = { aspect: Aspect; width: number; height: number; durationS: number; fps: number };

/** Remux (no re-encode) so moov leads, then hold the master to the order's output spec. Returns the KFC1 media. */
export async function prepareMaster(src: string, dir: string, want: Output, ff: FfOptions) {
  const master = path.join(dir, "master.mp4");
  await remuxFaststart(src, master, ff);
  const issues = specIssues(await probe(master, ff), want);
  const header = parseMp4Header(await readHead(master, KFC1_CHUNK_PLAINTEXT));
  if (!header) issues.push("moov is not inside the first KFC1 chunk (1 MiB) even after a faststart remux");
  if (issues.length > 0) {
    throw new StudioError(`the master does not match the order's spec:\n  - ${issues.join("\n  - ")}`);
  }
  const media = {
    mime: "video/mp4" as const,
    width: header?.width ?? want.width,
    height: header?.height ?? want.height,
    durationMs: header?.durationMs ?? want.durationS * 1000,
    fps: want.fps,
  };
  return { master, media, artifact: await artifact(master) };
}

export class StudioError extends Error {}

function tilesFor(cfg: BaseConfig, log: Logger): Tiles {
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

const ffOf = (cfg: BaseConfig): FfOptions => ({
  ffmpeg: cfg.FFMPEG_PATH,
  ffprobe: cfg.FFPROBE_PATH,
  timeoutMs: cfg.FFMPEG_TIMEOUT_MS,
});

const when = (s: unknown) => (typeof s === "number" ? new Date(s * 1000).toISOString().replace(".000Z", "Z") : "?");

export async function studioCmd(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "inbox":
      return inbox();
    case "check":
      return checkLocal(rest);
    case "deliver":
      return deliver(rest);
    case "cancel":
      return cancel(rest);
    default:
      process.stderr.write(`usage:\n${STUDIO_HELP}`);
      return 2;
  }
}

function client(log: Logger) {
  const cfg = loadServiceConfig();
  // A stable id of its own: re-running deliver re-opens the job this CLI holds, and the render worker's
  // liveness is never inferred from Studio traffic.
  const api = new ApiClient({
    base: cfg.API_BASE,
    token: cfg.WORKER_TOKEN,
    workerId: `studio-${cfg.WORKER_ID}`.slice(0, 64),
    timeoutMs: cfg.HTTP_TIMEOUT_MS,
    uploadTimeoutMs: cfg.UPLOAD_TIMEOUT_MS,
    log,
  });
  return { cfg, api };
}

async function publicQuote(cfg: { API_BASE: string; HTTP_TIMEOUT_MS: number }, quoteId: string) {
  const res = await request(new URL(`/v1/quotes/${quoteId}`, cfg.API_BASE).href, {
    method: "GET",
    timeoutMs: cfg.HTTP_TIMEOUT_MS,
  });
  return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
}

async function inbox(): Promise<number> {
  const log = createLogger("warn");
  const { cfg, api } = client(log);
  const body = (await api.getJson("/internal/studio/orders")) as { orders?: Record<string, unknown>[] };
  const orders = body.orders ?? [];
  if (orders.length === 0) {
    process.stdout.write("No open Studio orders.\n");
    return 0;
  }
  for (const o of orders) {
    const q = await publicQuote(cfg, String(o.quote_id)).catch(() => null);
    const spec = (q?.spec ?? {}) as Record<string, unknown>;
    const lines = [
      `${o.order_id}  ${String(o.status).toUpperCase()}  deliver by ${when(o.deadline)}`,
      `  format ${spec.format ?? q?.format ?? "?"}  ${spec.aspect ?? "?"}  ${spec.durationS ?? spec.duration_s ?? "?"} s  ${
        (q?.price as { usdc?: string } | undefined)?.usdc ?? "?"
      } USDC`,
      `  brief ${JSON.stringify(spec.params ?? {}).slice(0, 400)}`,
    ];
    if (o.change_requested_at) {
      lines.push(
        `  change requested ${when(o.change_requested_at)}; revision ${o.revision_delivered_at ? "delivered" : "due"}`,
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return 0;
}

async function checkLocal(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { aspect: { type: "string" }, duration: { type: "string" }, fps: { type: "string", default: "30" } },
  });
  const file = positionals[0];
  const aspect = values.aspect as Aspect | undefined;
  if (!file || !aspect || !(aspect in ASPECTS) || !values.duration) {
    process.stderr.write(`usage:\n${STUDIO_HELP}`);
    return 2;
  }
  const cfg = loadBaseConfig();
  const log = createLogger("warn");
  const size = ASPECTS[aspect];
  const want = { aspect, ...size, durationS: Number(values.duration), fps: Number(values.fps) };
  const dir = path.join(cfg.WORK_DIR, "studio", `check-${process.pid}`);
  await mkdir(dir, { recursive: true });
  try {
    const m = await prepareMaster(path.resolve(file), dir, want, ffOf(cfg));
    const preview = path.join(dir, "preview.mp4");
    const tile = await tilesFor(cfg, log).get(aspect);
    await makePreview(m.master, tile, preview, previewSize(want.width, want.height), cfg.PREVIEW_CRF, ffOf(cfg));
    const seal = await sealRoundTrip(m.master, m.media, path.join(dir, "sealed"));
    if (!seal.roundTrip || !seal.manifestVerified) throw new StudioError("the KFC1 seal round trip failed");
    process.stdout.write(
      `OK  ${want.width}x${want.height} ${want.durationS}s @${want.fps}fps  ${m.artifact.size} bytes  sha256 ${m.artifact.sha256}\n` +
        `    watermarked review preview ${(await artifact(preview)).size} bytes; KFC1 seal + decrypt round trip ok (${seal.chunks} chunk(s))\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof StudioError) {
      process.stderr.write(`NOT OK: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    await removeDir(dir);
  }
}

async function deliver(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "keep-work": { type: "boolean", default: false } },
  });
  const [orderId, file] = positionals;
  if (!orderId || !file || !/^o_[1-9A-HJ-NP-Za-km-z]{22}$/.test(orderId)) {
    process.stderr.write(`usage:\n${STUDIO_HELP}`);
    return 2;
  }
  const log = createLogger("warn");
  const { cfg, api } = client(log);
  const job = JobInputsSchema.parse(await api.post(`/internal/studio/orders/${orderId}/delivery`, {}));
  if (job.kind !== "studio_delivery") throw new StudioError(`expected a studio_delivery job, got ${job.kind}`);
  const o = job.output;
  const want = { aspect: o.aspect, width: o.width, height: o.height, durationS: o.duration_s, fps: o.fps };
  const dir = path.join(cfg.WORK_DIR, "studio", `${job.job_id}-${job.attempt}`);
  await mkdir(dir, { recursive: true });
  try {
    process.stdout.write(`order ${orderId}: spec ${o.width}x${o.height} ${o.duration_s}s @${o.fps}fps\n`);
    const m = await prepareMaster(path.resolve(file), dir, want, ffOf(cfg));
    const preview = path.join(dir, "preview.mp4");
    const tile = await tilesFor(cfg, log).get(o.aspect);
    await makePreview(m.master, tile, preview, previewSize(o.width, o.height), cfg.PREVIEW_CRF, ffOf(cfg));
    const sealed: Sealed = await sealFile(
      m.master,
      job.kfc1.k_file as `0x${string}`,
      job.kfc1.salt as `0x${string}`,
      m.media,
    );
    if (sealed.manifest.plaintextSha256 !== m.artifact.sha256) {
      throw new StudioError("sealed bytes differ from the master; nothing was uploaded");
    }
    await api.put(job.upload.preview, { file: preview }, "video/mp4");
    await api.putManifest(job.upload.manifest, sealed.manifest, sealed.manifestHash);
    for (const [i, chunk] of sealed.chunks.entries()) {
      await api.put(job.upload.chunk.replace("{i}", String(i)), { bytes: chunk }, "application/octet-stream");
    }
    const done = (await api.done(job.upload.done, {})) as { state?: string; tx?: string };
    process.stdout.write(
      `delivered: manifest ${sealed.manifestHash}, ${sealed.chunks.length} chunk(s); deliver tx ${done.tx ?? "?"} (${
        done.state ?? "?"
      }).\nThe buyer now reviews the watermarked preview and can accept, ask for one change, or reject.\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof StudioError) {
      process.stderr.write(`NOT DELIVERED: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    if (!values["keep-work"]) await removeDir(dir);
  }
}

async function cancel(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean", default: false } },
  });
  const orderId = positionals[0];
  if (!orderId || !/^o_[1-9A-HJ-NP-Za-km-z]{22}$/.test(orderId)) {
    process.stderr.write(`usage:\n${STUDIO_HELP}`);
    return 2;
  }
  if (!values.yes) {
    process.stderr.write(`This voids ${orderId} and refunds the buyer in full. Re-run with --yes to confirm.\n`);
    return 2;
  }
  const { api } = client(createLogger("warn"));
  process.stdout.write(`${JSON.stringify(await api.post(`/internal/studio/orders/${orderId}/cancel`, {}))}\n`);
  return 0;
}
