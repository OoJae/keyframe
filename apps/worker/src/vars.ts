import { readFile } from "node:fs/promises";
import path from "node:path";
import { COLOR_RE, KIT_DIR, type Template, TemplateError, type VariableValues, validateValues } from "./templates.ts";

// toTemplateVars: the quote's spec params (frozen-interfaces §6 `params`, as the API sends them in a job) → the
// template's typed variables. The LLM only ever fills typed params (B3). This step formats and resolves them,
// and validateValues() then enforces the template's declared limits. A template without a mapper here cannot be
// rendered from a job.

export type MapInput = {
  params: Record<string, unknown>;
  quoteId: string;
  /** Time anchor for anything relative to "now" (countdown), in unix seconds. */
  anchorS: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "UTC+1", "UTC+5:30", "UTC-3" for an offset in minutes. */
const offsetLabel = (off: number) => {
  const a = Math.abs(off);
  return `UTC${off < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${two(a % 60)}` : ""}`;
};

/**
 * "Oct 24 · 19:00 WAT" from an ISO-8601 instant, shown in the UTC offset the buyer wrote and labelled with tz_label
 * (else "UTC+1"). Locale-independent on purpose. A label can't be checked against "Z", so it is used only with a
 * non-zero offset: a UTC time is always shown as UTC, never mislabelled as somebody's local time.
 */
export function formatTarget(iso: string, tzLabel?: unknown): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    throw new TemplateError("bad_variables", `not a datetime: ${JSON.stringify(iso).slice(0, 40)}`);
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso.trim());
  const off = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const label = typeof tzLabel === "string" ? tzLabel.trim() : "";
  const zone = off === 0 ? "UTC" : /^[A-Za-z][A-Za-z0-9+:/ -]{0,11}$/.test(label) ? label : offsetLabel(off);
  const at = new Date(d.getTime() + off * 60_000);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} · ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} ${zone}`;
}

type Palette = { bg: string; fg: string; accent: string };

/** Preset names resolve through templates/_kit/palettes.json (builder-designed; null = not designed yet). */
export async function resolvePalette(templatesDir: string, palette: unknown): Promise<Palette | null> {
  if (palette && typeof palette === "object") {
    const p = palette as Record<string, unknown>;
    const ok = (v: unknown): v is string => typeof v === "string" && COLOR_RE.test(v);
    if (ok(p.bg) && ok(p.fg) && ok(p.accent)) return { bg: p.bg, fg: p.fg, accent: p.accent };
    throw new TemplateError("bad_variables", "palette must be {bg, fg, accent} as #rrggbb");
  }
  if (typeof palette !== "string") return null;
  const presets = JSON.parse(await readFile(path.join(templatesDir, KIT_DIR, "palettes.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (!Object.hasOwn(presets, palette) || palette.startsWith("//")) {
    throw new TemplateError("bad_variables", `unknown palette preset ${JSON.stringify(palette).slice(0, 40)}`);
  }
  const preset = presets[palette];
  return preset === null ? null : resolvePalette(templatesDir, preset);
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

type Mapper = (t: Template, i: MapInput, palette: Palette | null) => Record<string, unknown>;

const MAPPERS: Record<string, Mapper> = {
  countdown: (t, i, palette) => {
    const target = str(i.params.target);
    const targetS = Math.floor(new Date(target).getTime() / 1000);
    if (!Number.isFinite(targetS)) throw new TemplateError("bad_variables", "countdown needs params.target (ISO-8601)");
    const max = t.variables.find((v) => v.id === "remaining_s");
    const cap = max?.type === "number" ? max.max : Number.MAX_SAFE_INTEGER;
    return {
      label: str(i.params.label),
      target_text: formatTarget(target, i.params.tz_label),
      remaining_s: Math.min(cap, Math.max(0, targetS - i.anchorS)),
      cta: str(i.params.cta),
      ...(palette ?? {}),
    };
  },
  probe: (_t, i) => {
    const values = (i.params.values ?? {}) as Record<string, unknown>;
    const id = str(values.probe_id);
    return { probe_id: /^[A-Za-z0-9_-]{1,32}$/.test(id) ? id : i.quoteId };
  },
};

export function hasMapper(templateId: string): boolean {
  return Object.hasOwn(MAPPERS, templateId);
}

/** Map spec params to validated template variables (missing optional variables take the template default). */
export async function toTemplateVars(templatesDir: string, t: Template, input: MapInput): Promise<VariableValues> {
  const mapper = MAPPERS[t.id];
  if (!mapper) throw new TemplateError("not_renderable", `no params mapping for template ${t.id}`);
  const palette = await resolvePalette(templatesDir, input.params.palette);
  const mapped = mapper(t, input, palette);
  const declared = new Set(t.variables.map((v) => v.id));
  const values = Object.fromEntries(Object.entries(mapped).filter(([k]) => declared.has(k)));
  return validateValues(t, values, true);
}
