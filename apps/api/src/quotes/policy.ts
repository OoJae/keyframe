import { DESIGNED_PALETTES } from "../templates.js";
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
/** Any host-like token (label.tld, also bare "drainer.com", "x.co/claim", "@a.b", "xn--…"): no links in renders. */
const DOMAIN_IN_TEXT =
  /(?:^|[^\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}{2,24}|xn--[a-z0-9-]{1,59})(?=$|[^\p{L}\p{N}-])/iu;

// Lookalikes folded to Latin before the denylist runs (Cyrillic / Greek letters that render like a-z).
const CONFUSABLES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "i",
  ї: "i",
  ј: "j",
  ԁ: "d",
  ӏ: "l",
  һ: "h",
  ԛ: "q",
  ԝ: "w",
  ү: "y",
  ɡ: "g",
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
};
/** Leetspeak, applied only inside tokens that also contain a letter ("n4z1", "p0rn"), never to plain numbers. */
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
/** Default-ignorable / format characters that render as nothing (stripped, then the text is re-checked). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/** NFKC (fullwidth → ASCII, ligatures), invisible characters and accents removed, lowercased, lookalikes folded. */
export function foldText(raw: string): string {
  const base = raw.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
  let out = "";
  for (const ch of base.normalize("NFD").replace(/\p{M}+/gu, "")) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/[\p{L}\p{N}@$]+/gu, (tok) =>
    /\p{L}/u.test(tok) ? Array.from(tok, (c) => LEET[c] ?? c).join("") : tok,
  );
}

/**
 * Collapses letters spelled out with separators ("n.a.z.i", "n a z i", "n-a-z-i") into one word, so a
 * word-boundary denylist sees "nazi". Only runs of 3+ single characters are joined; ordinary words are untouched.
 */
export function collapseSpelled(folded: string): string {
  return folded.replace(/(?<![\p{L}\p{N}])\p{L}(?:[\s.\-_*·•|/\\,'"`~+:;]+\p{L}(?![\p{L}\p{N}])){2,}/gu, (m) =>
    m.replace(/[^\p{L}]/gu, ""),
  );
}
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
/** Every string leaf (and key) of a JSON value, with its path; bounded so a hostile value cannot blow up. */
function jsonStrings(path: string, v: unknown, out: [string, string][], depth = 0): void {
  if (out.length > 2_000 || depth > 16) return;
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) jsonStrings(`${path}.${i}`, x, out, depth + 1);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push([`${path}.${k}`, k]);
      jsonStrings(`${path}.${k}`, x, out, depth + 1);
    }
  }
}

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
      if (r.params.portfolio !== undefined) jsonStrings("params.portfolio", r.params.portfolio, out);
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
      jsonStrings("params.values", r.params.values, out);
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
    const folded = foldText(value);
    if (deny.test(value) || deny.test(folded) || deny.test(collapseSpelled(folded))) {
      return { ok: false, reason: "disallowed_content", field };
    }
    // Studio briefs may cite links in `references`; nowhere else may text carry a URL into a render.
    const plain = value.normalize("NFKC").replace(INVISIBLE, "");
    if (URL_IN_TEXT.test(plain) || DOMAIN_IN_TEXT.test(plain)) {
      return { ok: false, reason: "links_not_allowed_in_text", field };
    }
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

/** Formats whose worker mapper fetches and renders params.logo_url (none yet). */
const LOGO_FORMATS: ReadonlySet<string> = new Set<string>();

export type Unsupported = { field: string; detail: string };

/**
 * Options the request schema accepts (the frozen plugin offers them) that nothing renders yet: an explicit 422
 * instead of a silently ignored choice. Runs once the format is known to be sellable.
 */
export function unsupportedOption(
  r: QuoteRequest,
  designedPalettes: ReadonlySet<string> = DESIGNED_PALETTES,
): Unsupported | null {
  if (typeof r.palette === "string" && !designedPalettes.has(r.palette)) {
    return {
      field: "palette",
      detail: `palette preset "${r.palette}" is not designed yet; omit palette to use the style's own colours, or pass {bg, fg, accent} as #RRGGBB`,
    };
  }
  if (r.format === "launch_sting" && r.params.logo_url !== undefined && !LOGO_FORMATS.has(r.format)) {
    return { field: "params.logo_url", detail: "launch_sting does not render logos yet; omit logo_url" };
  }
  return null;
}
