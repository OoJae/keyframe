import * as z from "zod/v4";
import { AspectSchema } from "./templates.ts";

// The API's internal render-job contract (apps/api/src/internal/jobs.ts `jobInputs`, mounted at /internal).
// Parsed loosely at the top level (the API may add fields) and strictly on every field the worker acts on.

const Bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, "expected lowercase 0x + 64 hex");
/** Upload/report targets are paths on the API itself; the bearer token is only ever sent to API_BASE's origin. */
const InternalPath = z
  .string()
  .regex(/^\/internal\/jobs\/[A-Za-z0-9_.:-]{1,80}\/[a-z]+(\/\{i\})?$/, "expected an /internal/jobs/... path");

export const JobKindSchema = z.enum(["instant_render", "studio_delivery"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobInputsSchema = z.looseObject({
  job_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  kind: JobKindSchema,
  attempt: z.int().min(1),
  lease_expires_at: z.int().nullable().optional(),
  quote_id: z.string().regex(/^q_[1-9A-HJ-NP-Za-km-z]{22}$/),
  order_id: z.string().nullable().optional(),
  /** Instant only: which template renders this quote. */
  template: z
    .looseObject({
      id: z.string().min(1).max(64),
      catalog_id: z.string().min(1).max(64),
      format: z.string().min(1),
      style: z.string().min(1).max(32),
    })
    .nullable(),
  output: z.looseObject({
    mime: z.literal("video/mp4"),
    aspect: AspectSchema,
    width: z.int(),
    height: z.int(),
    duration_s: z.int().min(1).max(120),
    fps: z.int().min(1).max(60),
    hero_ms: z.int().min(0),
    faststart: z.literal(true),
  }),
  params: z.record(z.string(), z.unknown()),
  data_snapshot: z.unknown().optional(),
  watermark: z.looseObject({ text: z.string().max(200) }).optional(),
  kfc1: z.looseObject({ alg: z.literal("KFC1"), salt: Bytes32, k_file: Bytes32, chunk_size: z.literal(1_048_560) }),
  requires: z.array(z.string()),
  upload: z.looseObject({
    still: InternalPath,
    preview: InternalPath,
    manifest: InternalPath,
    chunk: InternalPath,
    heartbeat: InternalPath,
    done: InternalPath,
    failed: InternalPath,
  }),
});
export type JobInputs = z.infer<typeof JobInputsSchema>;

/** Enough of a payload to report a failure for a job whose inputs did not validate. */
export const JobRefSchema = z.looseObject({
  job_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  upload: z.looseObject({ failed: InternalPath }),
});

export type FailureCode =
  | "bad_job"
  | "bad_template"
  | "bad_variables"
  | "deadline_passed"
  | "render_failed"
  | "timeout"
  | "spec_mismatch"
  | "upload_rejected"
  | "upload_failed"
  | "cancelled"
  | "shutdown"
  | "internal";
