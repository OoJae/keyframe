import type { QuoteRequest } from "./request.js";

// Content policy for Instant/Studio requests (architecture.md §f threat 9, product-render-demo.md §B3).
// Instant formats take typed text only (no likeness inputs); this layer rejects disallowed text, links smuggled
// into rendered text, spoofing characters, unsafe URLs and unreadable palettes. Studio briefs get the same text
// checks and are then reviewed by the human designer before acceptance.

export type PolicyResult = { ok: true } | { ok: false; reason: string; field: string };

// Built-in denylist (word-boundary, case-insensitive). Extend per deployment with POLICY_DENYLIST.
const BUILTIN_DENYLIST = [
  "porn",
  "porno",
  "nsfw",
  "nude",
  "nudes",
  "naked",
  "onlyfans",
  "deepfake",
  "csam",
  "lolita",
  "nazi",
  "terrorist",
  "isis",
  "kill yourself",
  "guaranteed returns",
  "airdrop claim",
  "seed phrase",
  "private key",
];

const URL_IN_TEXT = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|xyz|app|net|org|gg|me)\/\S/i;
/** C0/C1 controls (rendered text never needs them), zero-width characters and bidi overrides used for spoofing. */
function hasForbiddenChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) {
      return true;
    }
  }
  return false;
}
// Mirrors the plugin's keyframe_quote bound (32 KiB), so anything the plugin forwards is accepted.
const MAX_PORTFOLIO_JSON = 32 * 1024;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function denyRegex(extra: readonly string[]): RegExp {
  const terms = [...BUILTIN_DENYLIST, ...extra].map((t) => escapeRe(t.toLowerCase()).replace(/\s+/g, "\\s+"));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${terms.join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");
}

function safeHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) return false; // IP literals
  return h.includes(".");
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

/** WCAG 2.x contrast ratio of two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text fields that end up rendered (or read by a human designer), with their request paths. */
function textFields(r: QuoteRequest): [string, string][] {
  const out: [string, string][] = [];
  const add = (path: string, v: string | undefined) => {
    if (v !== undefined) out.push([path, v]);
  };
  add("notes", r.notes);
  switch (r.format) {
    case "launch_sting":
      add("params.wordmark", r.params.wordmark);
      add("params.tagline", r.params.tagline);
      break;
    case "countdown":
      add("params.label", r.params.label);
      add("params.cta", r.params.cta);
      add("params.tz_label", r.params.tz_label);
      break;
    case "portfolio_pulse":
      add("params.title", r.params.title);
      add("params.handle", r.params.handle);
      r.params.holdings?.forEach((h, i) => {
        add(`params.holdings.${i}.symbol`, h.symbol);
      });
      break;
    case "kinetic_post":
      add("params.text", r.params.text);
      add("params.byline", r.params.byline);
      r.params.emphasis?.forEach((w, i) => {
        add(`params.emphasis.${i}`, w);
      });
      break;
    case "chart_moment":
      add("params.asset", r.params.asset);
      add("params.callout", r.params.callout);
      break;
    case "studio":
      add("params.brief", r.params.brief);
      break;
    case "catalog":
      for (const [k, v] of Object.entries(r.params.values)) if (typeof v === "string") add(`params.values.${k}`, v);
      break;
  }
  return out;
}

function urlFields(r: QuoteRequest): [string, string][] {
  if (r.format === "launch_sting" && r.params.logo_url) return [["params.logo_url", r.params.logo_url]];
  if (r.format === "studio") {
    const out: [string, string][] = (r.params.references ?? []).map((u, i) => [`params.references.${i}`, u]);
    if (r.params.brand_assets_url) out.push(["params.brand_assets_url", r.params.brand_assets_url]);
    return out;
  }
  return [];
}

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export function checkPolicy(r: QuoteRequest, nowS: number, extraDenylist: readonly string[] = []): PolicyResult {
  const deny = denyRegex(extraDenylist);
  for (const [field, value] of textFields(r)) {
    if (hasForbiddenChar(value)) return { ok: false, reason: "forbidden_characters", field };
    if (deny.test(value)) return { ok: false, reason: "disallowed_content", field };
    // Studio briefs may cite links in `references`; nowhere else may text carry a URL into a render.
    if (URL_IN_TEXT.test(value)) return { ok: false, reason: "links_not_allowed_in_text", field };
  }
  for (const [field, value] of urlFields(r)) {
    if (!safeHttpsUrl(value)) return { ok: false, reason: "unsafe_url", field };
  }
  if (r.palette && typeof r.palette === "object") {
    if (contrastRatio(r.palette.fg, r.palette.bg) < 4.5) return { ok: false, reason: "low_contrast", field: "palette" };
  }
  if (r.format === "countdown") {
    const t = Date.parse(r.params.target) / 1000;
    if (!(t > nowS + 60 && t <= nowS + 366 * 86_400)) {
      return { ok: false, reason: "target_out_of_range", field: "params.target" };
    }
  }
  if (r.format === "kinetic_post" && wordCount(r.params.text) > 50) {
    return { ok: false, reason: "too_many_words", field: "params.text" };
  }
  if (r.format === "portfolio_pulse") {
    const p = r.params;
    if (p.portfolio === undefined && (p.holdings === undefined || p.holdings.length === 0)) {
      return { ok: false, reason: "portfolio_or_holdings_required", field: "params.portfolio" };
    }
    if (p.portfolio !== undefined && JSON.stringify(p.portfolio).length > MAX_PORTFOLIO_JSON) {
      return { ok: false, reason: "portfolio_too_large", field: "params.portfolio" };
    }
  }
  return { ok: true };
}
