import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ASPECTS,
  type Aspect,
  bundleFiles,
  heroTimeOf,
  isRenderable,
  type LoadedTemplate,
  TemplateError,
  type VariableValues,
  validateValues,
} from "./templates.ts";

// Per-job composition. HyperFrames reads the root data-duration/width/height once at compile time and `snapshot`
// takes no variables, so the worker writes a concrete index.html per job from index.tmpl.html:
// - KF_* tokens in double braces are replaced (the full list is TOKENS below; anything else in braces is an error);
// - KF_VARIABLES becomes the data-composition-variables declarations with each default set to the job's value,
//   so snapshot, check and render all see the same values (render also gets them via --variables-file).

export const TOKENS = [
  "KF_WIDTH",
  "KF_HEIGHT",
  "KF_DURATION",
  "KF_FPS",
  "KF_ASPECT",
  "KF_ASPECT_RATIO",
  "KF_STYLE",
  "KF_VARIABLES",
  "KF_TEMPLATE_ID",
  "KF_TEMPLATE_VERSION",
] as const;
const REQUIRED: readonly (typeof TOKENS)[number][] = ["KF_WIDTH", "KF_HEIGHT", "KF_DURATION", "KF_VARIABLES"];
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type StampRequest = {
  templatesDir: string;
  template: LoadedTemplate;
  aspect: Aspect;
  durationS: number;
  style: string;
  values: VariableValues;
  outDir: string;
};

export type Stamped = {
  dir: string;
  indexPath: string;
  varsPath: string;
  width: number;
  height: number;
  fps: number;
  durationS: number;
  heroTimeS: number;
  values: VariableValues;
};

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stampHtml(source: string, values: Record<(typeof TOKENS)[number], string>): string {
  // Every "{{" in the template must open a well-formed token; checked on the source, since job values may contain braces.
  const opens = source.split("{{").length - 1;
  const wellFormed = [...source.matchAll(TOKEN_RE)].length;
  if (opens !== wellFormed) throw new TemplateError("bad_template", "index.tmpl.html has a malformed {{...}} token");
  const seen = new Set<string>();
  const out = source.replace(TOKEN_RE, (_m, name: string) => {
    if (!(TOKENS as readonly string[]).includes(name)) {
      throw new TemplateError("bad_template", `index.tmpl.html uses unknown token {{${name}}}`);
    }
    seen.add(name);
    return values[name as (typeof TOKENS)[number]];
  });
  for (const t of REQUIRED) {
    if (!seen.has(t)) throw new TemplateError("bad_template", `index.tmpl.html must use {{${t}}}`);
  }
  return out;
}

/** Validate the request against template.json and write the job directory. */
export async function stamp(req: StampRequest): Promise<Stamped> {
  const { meta } = req.template;
  if (!isRenderable(meta)) {
    throw new TemplateError("not_renderable", `${meta.id} is ${meta.status}; it has no design to render yet`);
  }
  const size = meta.aspects[req.aspect];
  if (!size) throw new TemplateError("bad_aspect", `${meta.id} does not support aspect ${req.aspect}`);
  if (!meta.durations.includes(req.durationS)) {
    throw new TemplateError(
      "bad_duration",
      `${meta.id} durations are ${meta.durations.join("/")}s, not ${req.durationS}s`,
    );
  }
  if (!meta.styles.includes(req.style)) {
    throw new TemplateError("bad_style", `${meta.id} styles are ${meta.styles.join(", ")}, not ${req.style}`);
  }
  const values = validateValues(meta, req.values);
  const heroTimeS = heroTimeOf(meta, req.durationS);

  // Copy the bundle (template minus docs/design/index.tmpl.html, kit at kit/), then write index.html.
  const files = await bundleFiles(req.templatesDir, meta.id);
  let tmpl: string | null = null;
  for (const [rel, abs] of files) {
    if (rel === "index.tmpl.html") {
      tmpl = await readFile(abs, "utf8");
      continue;
    }
    if (rel === "template.json" || rel === "index.html") continue;
    const dest = path.join(req.outDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(abs, dest);
  }
  if (tmpl === null) throw new TemplateError("bad_template", `${meta.id} has no index.tmpl.html`);

  const declarations = meta.variables.map((v) => ({
    id: v.id,
    type: v.type,
    label: v.label,
    default: values[v.id],
    ...(v.type === "enum" ? { options: v.options } : {}),
  }));
  const html = stampHtml(tmpl, {
    KF_WIDTH: String(size.width),
    KF_HEIGHT: String(size.height),
    KF_DURATION: String(req.durationS),
    KF_FPS: String(meta.fps),
    KF_ASPECT: ASPECTS[req.aspect].slug,
    KF_ASPECT_RATIO: req.aspect,
    KF_STYLE: req.style,
    KF_VARIABLES: escapeAttr(JSON.stringify(declarations)),
    KF_TEMPLATE_ID: escapeAttr(meta.id),
    KF_TEMPLATE_VERSION: escapeAttr(meta.version),
  });
  await mkdir(req.outDir, { recursive: true });
  const indexPath = path.join(req.outDir, "index.html");
  const varsPath = path.join(req.outDir, "vars.json");
  await writeFile(indexPath, html);
  await writeFile(varsPath, `${JSON.stringify(values)}\n`);
  return {
    dir: req.outDir,
    indexPath,
    varsPath,
    width: size.width,
    height: size.height,
    fps: meta.fps,
    durationS: req.durationS,
    heroTimeS,
    values,
  };
}
