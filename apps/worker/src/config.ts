import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

export const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TEMPLATES_DIR = path.resolve(WORKER_ROOT, "..", "..", "templates");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https everywhere, except plain http to a loopback host (local API, tests, cloudflared on the same box). */
export function isAllowedRemoteUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

const intFromEnv = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const flag = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");

const Base = z.object({
  TEMPLATES_DIR: z.string().min(1).default(DEFAULT_TEMPLATES_DIR),
  WORK_DIR: z.string().min(1).default(path.join(tmpdir(), "keyframe-worker")),
  KEEP_JOBS: flag,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  /** hyperframes render --workers: an integer, or "auto". B5 uses 3 on the 4 vCPU box. */
  RENDER_WORKERS: z.union([z.literal("auto"), z.string().regex(/^[1-9]$/)]).default("3"),
  RENDER_CRF: intFromEnv(0, 51).default(20),
  PREVIEW_CRF: intFromEnv(0, 51).default(30),
  /** Browser GPU for snapshot and render alike. "off" (SwiftShader) gives byte-identical re-renders; hardware GPU
   *  capture does not (measured: 16:9 countdown, 58 dB PSNR between runs). Same speed for these templates. */
  BROWSER_GPU: z.enum(["auto", "on", "off"]).default("off"),
  HERO_SSIM_MIN: z.coerce.number().min(0).max(1).default(0.97),
  STILL_TIMEOUT_MS: intFromEnv(5_000, 600_000).default(45_000),
  /** Floor for the render stage; the template's perf budget x4 is used when larger. */
  RENDER_TIMEOUT_MS: intFromEnv(30_000, 3_600_000).default(180_000),
  FFMPEG_TIMEOUT_MS: intFromEnv(5_000, 600_000).default(120_000),
});

const Service = Base.extend({
  API_BASE: z
    .string()
    .refine(isAllowedRemoteUrl, "API_BASE must be https:// (http:// only for a loopback host)")
    .transform((s) => s.replace(/\/+$/, "")),
  WORKER_TOKEN: z.string().min(32, "WORKER_TOKEN must be at least 32 characters"),
  WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default(
      hostname()
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 64) || "worker",
    ),
  /** Concurrent jobs. Each instant_render job renders a still, then the master (B7: one render lane). */
  RENDER_LANES: intFromEnv(1, 8).default(1),
  POLL_INTERVAL_MS: intFromEnv(200, 60_000).default(2_000),
  /** Job lease renewal + progress report interval (the API's lease is 600 s). */
  HEARTBEAT_INTERVAL_MS: intFromEnv(1_000, 300_000).default(15_000),
  HTTP_TIMEOUT_MS: intFromEnv(1_000, 120_000).default(15_000),
  UPLOAD_TIMEOUT_MS: intFromEnv(5_000, 900_000).default(120_000),
  DRAIN_TIMEOUT_MS: intFromEnv(0, 3_600_000).default(120_000),
  HEALTH_HOST: z.string().min(1).default("127.0.0.1"),
  HEALTH_PORT: intFromEnv(0, 65_535).default(8790),
});

export type BaseConfig = z.infer<typeof Base>;
export type ServiceConfig = z.infer<typeof Service>;

function parse<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const res = schema.safeParse(env);
  if (res.success) return res.data;
  // Report keys and reasons only, never values (WORKER_TOKEN is one of them).
  const lines = res.error.issues.map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`);
  throw new Error(`invalid configuration:\n${lines.join("\n")}`);
}

export const loadBaseConfig = (env: NodeJS.ProcessEnv = process.env): BaseConfig => parse(Base, env);
export const loadServiceConfig = (env: NodeJS.ProcessEnv = process.env): ServiceConfig => parse(Service, env);
