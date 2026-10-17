import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

// template.json (templates/template.schema.json is generated from TemplateSchema by `cli.ts schema`).

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920, slug: "9x16" },
  "1:1": { width: 1080, height: 1080, slug: "1x1" },
  "16:9": { width: 1920, height: 1080, slug: "16x9" },
} as const;
export type Aspect = keyof typeof ASPECTS;
export const ASPECT_IDS = Object.keys(ASPECTS) as Aspect[];
export const AspectSchema = z.enum(["9:16", "1:1", "16:9"]);

export const SPEC_FORMATS = [
  "launch_sting",
  "countdown",
  "portfolio_pulse",
  "kinetic_post",
  "chart_moment",
  "studio_sting",
  "studio_spot",
  "catalog",
] as const;

export const KIT_DIR = "_kit";
export const STAMP_VERSION = "keyframe-stamp/v1";
const ID_RE = /^_?[a-z][a-z0-9_]{1,39}$/;
const VAR_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Control characters are refused in every string variable: they have no business in on-screen text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point of this regex.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const Base = { id: z.string().regex(VAR_ID_RE), label: z.string().min(1).max(120), description: z.string().optional() };

const StringVar = z.strictObject({
  ...Base,
  type: z.literal("string"),
  default: z.string(),
  minLength: z.int().min(0).optional(),
  maxLength: z.int().min(1).max(16_384),
  pattern: z.string().optional(),
  /** The value must parse as JSON (arrays and records travel as JSON strings, parsed once at init). */
  json: z.boolean().optional(),
});
const NumberVar = z.strictObject({
  ...Base,
  type: z.literal("number"),
  default: z.number(),
  min: z.number(),
  max: z.number(),
  integer: z.boolean().optional(),
});
const ColorVar = z.strictObject({ ...Base, type: z.literal("color"), default: z.string().regex(COLOR_RE) });
const BooleanVar = z.strictObject({ ...Base, type: z.literal("boolean"), default: z.boolean() });
const EnumVar = z.strictObject({
  ...Base,
  type: z.literal("enum"),
  default: z.string(),
  options: z
    .array(z.strictObject({ value: z.string().min(1), label: z.string().min(1) }))
    .min(1)
    .max(64),
});

export const VariableSchema = z.discriminatedUnion("type", [StringVar, NumberVar, ColorVar, BooleanVar, EnumVar]);
export type Variable = z.infer<typeof VariableSchema>;

export const TemplateSchema = z
  .strictObject({
    $schema: z.string().optional(),
    id: z.string().regex(ID_RE),
    version: z.string().regex(SEMVER_RE),
    /** Spec format this template is sold under (frozen-interfaces §6); hidden formats use "catalog". */
    format: z.enum(SPEC_FORMATS),
    /** reference/production render; awaiting-design is a schema only; kit is internal (watermark tile). */
    status: z.enum(["production", "reference", "awaiting-design", "kit"]),
    title: z.string().min(1).max(120),
    styles: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)).max(32),
    aspects: z.partialRecord(AspectSchema, z.strictObject({ width: z.int(), height: z.int() })),
    fps: z.int().min(1).max(60),
    durations: z.array(z.int().min(1).max(120)).min(1),
    /** Seconds per duration (keys are the duration as a string). null only while awaiting design. */
    heroTime: z.record(z.string(), z.number().min(0).nullable()),
    perf: z.strictObject({
      /** Wall-clock budget for the render stage at this template's longest duration, 9:16, on the VPS. */
      renderBudgetS: z.number().positive(),
      /** Budget for the quote-time still (B4: the quote waits up to 4.5 s). */
      stillBudgetS: z.number().positive(),
    }),
    variables: z.array(VariableSchema).max(64),
    /** Kit-only settings for the watermark tile. */
    overlay: z.strictObject({ opacity: z.number().min(0.05).max(0.6) }).optional(),
  })
  .superRefine((t, ctx) => {
    const issue = (p: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path: p, message });
    const aspects = Object.entries(t.aspects);
    if (aspects.length === 0) issue(["aspects"], "at least one aspect");
    for (const [a, size] of aspects) {
      const want = ASPECTS[a as Aspect];
      if (size.width !== want.width || size.height !== want.height) {
        issue(["aspects", a], `${a} must be ${want.width}x${want.height}`);
      }
    }
    if (new Set(t.durations).size !== t.durations.length) issue(["durations"], "durations must be unique");
    const heroKeys = Object.keys(t.heroTime).sort();
    const durKeys = t.durations.map(String).sort();
    if (heroKeys.join() !== durKeys.join()) issue(["heroTime"], "heroTime needs exactly one entry per duration");
    for (const d of t.durations) {
      const h = t.heroTime[String(d)];
      if (h === null || h === undefined) {
        if (t.status !== "awaiting-design")
          issue(["heroTime", String(d)], "heroTime may be null only while awaiting design");
        continue;
      }
      if (h >= d) issue(["heroTime", String(d)], "heroTime must be inside the clip");
      if (Math.abs(h * t.fps - Math.round(h * t.fps)) > 1e-9) {
        issue(["heroTime", String(d)], `heroTime must be a whole frame at ${t.fps} fps`);
      }
    }
    const renderable = t.status !== "awaiting-design";
    if (renderable && t.styles.length === 0) issue(["styles"], "a renderable template needs at least one style");
    if (t.overlay && t.status !== "kit") issue(["overlay"], "overlay is for kit templates only");
    const ids = new Set<string>();
    t.variables.forEach((v, i) => {
      if (ids.has(v.id)) issue(["variables", i, "id"], `duplicate variable id ${v.id}`);
      ids.add(v.id);
      // Every default must itself be a valid value, so previews of the bare template are valid jobs.
      const res = variableSchema(v).safeParse(v.default);
      if (!res.success) issue(["variables", i, "default"], res.error.issues[0]?.message ?? "invalid default");
    });
  });
export type Template = z.infer<typeof TemplateSchema>;

function variableSchema(v: Variable): z.ZodType {
  switch (v.type) {
    case "string": {
      let s = z
        .string()
        .max(v.maxLength)
        .refine((x) => !CONTROL_RE.test(x), "control characters are not allowed");
      if (v.minLength !== undefined) s = s.refine((x) => x.length >= (v.minLength ?? 0), `min length ${v.minLength}`);
      if (v.pattern !== undefined) {
        const re = new RegExp(v.pattern);
        s = s.refine((x) => re.test(x), `must match ${v.pattern}`);
      }
      if (v.json) {
        s = s.refine((x) => {
          try {
            JSON.parse(x);
            return true;
          } catch {
            return false;
          }
        }, "must be valid JSON");
      }
      return s;
    }
    case "number": {
      const n = z.number().min(v.min).max(v.max);
      return v.integer ? n.int() : n;
    }
    case "color":
      return z.string().regex(COLOR_RE, "expected #rrggbb");
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(v.options.map((o) => o.value) as [string, ...string[]]);
  }
}

export type VariableValues = Record<string, string | number | boolean>;

/**
 * Validate job values against the template's declarations: unknown keys and wrong types are errors.
 * `fillDefaults` (local CLI only) fills missing keys from defaults; jobs from the API must be complete.
 */
export function validateValues(t: Template, values: unknown, fillDefaults = false): VariableValues {
  const shape: Record<string, z.ZodType> = {};
  for (const v of t.variables) shape[v.id] = variableSchema(v);
  const input =
    fillDefaults && values && typeof values === "object" && !Array.isArray(values)
      ? { ...Object.fromEntries(t.variables.map((v) => [v.id, v.default])), ...values }
      : values;
  const res = z.strictObject(shape).safeParse(input);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join(".") || "(values)"}: ${i.message}`).join("; ");
    throw new TemplateError("bad_variables", `variables for ${t.id}@${t.version}: ${msg}`);
  }
  // Declaration order, so vars.json and the stamped declarations are byte-stable.
  const out: VariableValues = {};
  for (const v of t.variables) out[v.id] = (res.data as VariableValues)[v.id] as string | number | boolean;
  return out;
}

export type TemplateErrorCode =
  | "unknown_template"
  | "not_renderable"
  | "bad_template"
  | "bad_variables"
  | "bad_aspect"
  | "bad_duration"
  | "bad_style"
  | "bad_hero";

export class TemplateError extends Error {
  override name = "TemplateError";
  readonly code: TemplateErrorCode;
  constructor(code: TemplateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type LoadedTemplate = { meta: Template; dir: string; hash: `0x${string}` };

/** Files that make up a template's render inputs, as [job-relative path, absolute path], sorted by job path. */
export async function bundleFiles(templatesDir: string, id: string): Promise<[string, string][]> {
  const files: [string, string][] = [];
  const walk = async (absDir: string, rel: string, prefix: string, skipDir: (rel: string) => boolean) => {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (!skipDir(r)) await walk(path.join(absDir, e.name), r, prefix, skipDir);
      } else if (e.isFile() && !e.name.endsWith(".md")) {
        files.push([`${prefix}${r}`, path.join(absDir, e.name)]);
      }
    }
  };
  // Template: everything except docs (*.md) and design material. index.tmpl.html is hashed as authored.
  await walk(path.join(templatesDir, id), "", "", (r) => r === "design");
  // Kit, mounted at kit/ in every job directory, minus its docs.
  await walk(path.join(templatesDir, KIT_DIR), "", "kit/", () => false);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return files;
}

/**
 * templateHash = sha256 over `${STAMP_VERSION}\n` followed by one line per bundle file, in byte order of path:
 * `<sha256 hex of content>  <job-relative path>\n` (the `sha256sum` line format). Reproducible from a shell:
 * see templates/README.md. This is spec.template.hash (frozen-interfaces §6).
 */
export async function templateHash(templatesDir: string, id: string): Promise<`0x${string}`> {
  const outer = createHash("sha256").update(`${STAMP_VERSION}\n`);
  for (const [rel, abs] of await bundleFiles(templatesDir, id)) {
    const inner = createHash("sha256")
      .update(await readFile(abs))
      .digest("hex");
    outer.update(`${inner}  ${rel}\n`);
  }
  return `0x${outer.digest("hex")}`;
}

export async function loadTemplate(templatesDir: string, id: string): Promise<LoadedTemplate> {
  if (!ID_RE.test(id)) throw new TemplateError("unknown_template", `invalid template id ${JSON.stringify(id)}`);
  const dir = path.join(templatesDir, id);
  const file = path.join(dir, "template.json");
  if (!existsSync(file)) throw new TemplateError("unknown_template", `no template ${id}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new TemplateError("bad_template", `${id}/template.json: ${(e as Error).message}`);
  }
  const res = TemplateSchema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new TemplateError("bad_template", `${id}/template.json: ${msg}`);
  }
  if (res.data.id !== id) throw new TemplateError("bad_template", `${id}/template.json declares id ${res.data.id}`);
  return { meta: res.data, dir, hash: await templateHash(templatesDir, id) };
}

/** Every template directory (anything with a template.json), sorted by id. The kit's own templates are included. */
export async function listTemplateIds(templatesDir: string): Promise<string[]> {
  const ids: string[] = [];
  for (const e of await readdir(templatesDir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(path.join(templatesDir, e.name, "template.json"))) ids.push(e.name);
  }
  return ids.sort();
}

export function isRenderable(t: Template): boolean {
  return t.status === "production" || t.status === "reference" || t.status === "kit";
}

/** Hero time in seconds for a duration; throws if the template has none yet. */
export function heroTimeOf(t: Template, durationS: number): number {
  const h = t.heroTime[String(durationS)];
  if (h === null || h === undefined) throw new TemplateError("bad_hero", `${t.id} has no hero time for ${durationS}s`);
  return h;
}

export function jsonSchema(): unknown {
  return z.toJSONSchema(TemplateSchema, { io: "input", unrepresentable: "any" });
}
