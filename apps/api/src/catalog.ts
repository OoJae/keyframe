import { isRenderable, TEMPLATES } from "./templates.js";

// Server-side catalog (not frozen: prices and formats may evolve after the plugin upload lock). Prices are atomic USDC
// (6 decimals); durations are whole seconds. For Instant formats, styles, hero frames and readiness come from the
// template the worker renders (templates/<id>/template.json, see templates.ts); Studio work has no template.

export type Tier = "instant" | "studio";
export type Aspect = "9:16" | "1:1" | "16:9";
export type SpecFormat =
  | "launch_sting"
  | "countdown"
  | "portfolio_pulse"
  | "kinetic_post"
  | "chart_moment"
  | "studio_sting"
  | "studio_spot"
  | "catalog";

export interface ParamDoc {
  id: string;
  type: "string" | "datetime" | "enum" | "number" | "url" | "json" | "array";
  label: string;
  required: boolean;
  max_length?: number;
  options?: readonly (string | number)[];
}

export interface CatalogItem {
  /** Catalog id (= spec format, except hidden `catalog` entries such as `probe`). */
  id: string;
  tier: Tier;
  specFormat: SpecFormat;
  title: string;
  description: string;
  styles: readonly string[];
  aspects: readonly Aspect[];
  /** Price per duration (seconds → atomic USDC). */
  prices: Readonly<Record<number, bigint>>;
  /** Instant: expected render seconds before the quote turns final. Studio: delivery SLA seconds. */
  etaS: number;
  /** Hero ("key frame") time per duration, ms. */
  heroMs: Readonly<Record<number, number>>;
  /** HyperFrames template id (= templates/<id>) the worker must render (Instant only). */
  templateId: string | null;
  /** Instant: the template is designed (status reference/production, styles declared). Studio: always. */
  renderable: boolean;
  defaultDelivery: "public" | "private";
  hidden: boolean;
  params: readonly ParamDoc[];
}

const usdc = (whole: number, cents = 0): bigint => BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n;
const ALL_ASPECTS: readonly Aspect[] = ["9:16", "1:1", "16:9"];
const STYLE: ParamDoc = { id: "style", type: "string", label: "Style id from this catalog", required: true };

const BASE: readonly CatalogItem[] = [
  {
    id: "launch_sting",
    tier: "instant",
    specFormat: "launch_sting",
    title: "Launch Sting",
    description: "Wordmark + tagline brand sting, hand-designed motion. 6 s or 10 s.",
    styles: [], // from templates/<id>/template.json
    aspects: ALL_ASPECTS,
    prices: { 6: usdc(4), 10: usdc(7) },
    etaS: 60,
    heroMs: { 6: 3400, 10: 5000 },
    templateId: "launch_sting",
    defaultDelivery: "public",
    hidden: false,
    renderable: false,
    params: [
      STYLE,
      { id: "wordmark", type: "string", label: "Wordmark text", required: true, max_length: 24 },
      { id: "tagline", type: "string", label: "Tagline", required: false, max_length: 60 },
      { id: "logo_url", type: "url", label: "https PNG/WebP/SVG logo (≤2 MB)", required: false, max_length: 512 },
      { id: "duration_s", type: "enum", label: "Duration in seconds", required: false, options: [6, 10] },
    ],
  },
  {
    id: "countdown",
    tier: "instant",
    specFormat: "countdown",
    title: "Countdown",
    description: "T-minus launch card; seconds tick for the clip. 8 s.",
    styles: [], // from templates/<id>/template.json
    aspects: ALL_ASPECTS,
    prices: { 8: usdc(1) },
    etaS: 45,
    heroMs: { 8: 3000 },
    templateId: "countdown",
    defaultDelivery: "public",
    hidden: false,
    renderable: false,
    params: [
      STYLE,
      { id: "label", type: "string", label: "What is launching", required: true, max_length: 32 },
      { id: "target", type: "datetime", label: "Launch time (ISO 8601, UTC)", required: true },
      { id: "cta", type: "string", label: "Call to action", required: false, max_length: 24 },
      { id: "tz_label", type: "string", label: "Timezone label", required: false, max_length: 12 },
    ],
  },
  {
    id: "portfolio_pulse",
    tier: "instant",
    specFormat: "portfolio_pulse",
    title: "Portfolio Pulse",
    description: "Portfolio card from PayBox get_portfolio: 24h move of current holdings (never PnL). 8 s.",
    styles: [], // from templates/<id>/template.json
    aspects: ALL_ASPECTS,
    prices: { 8: usdc(3) },
    etaS: 60,
    heroMs: { 8: 5800 },
    templateId: "portfolio_pulse",
    defaultDelivery: "private",
    hidden: false,
    renderable: false,
    params: [
      STYLE,
      { id: "title", type: "string", label: "Card title", required: false, max_length: 32 },
      { id: "handle", type: "string", label: "Handle", required: false, max_length: 24 },
      {
        id: "display",
        type: "enum",
        label: "Show percentages only or values",
        required: false,
        options: ["percent_only", "values"],
      },
      { id: "as_of", type: "datetime", label: "Snapshot time (ISO 8601)", required: true },
      { id: "portfolio", type: "json", label: "get_portfolio result, verbatim", required: false },
      { id: "holdings", type: "array", label: "Up to 6 {symbol, usd?, change_24h}", required: false },
    ],
  },
  {
    id: "kinetic_post",
    tier: "instant",
    specFormat: "kinetic_post",
    title: "Kinetic Post",
    description: "Your announcement as kinetic type. 6/9/12/15 s by word count (≤12/≤22/≤34/≤50 words).",
    styles: [], // from templates/<id>/template.json
    aspects: ALL_ASPECTS,
    prices: { 6: usdc(3), 9: usdc(3), 12: usdc(3), 15: usdc(3) },
    etaS: 60,
    heroMs: { 6: 5500, 9: 8500, 12: 11_500, 15: 14_500 },
    templateId: "kinetic_post",
    defaultDelivery: "public",
    hidden: false,
    renderable: false,
    params: [
      STYLE,
      { id: "text", type: "string", label: "Announcement text (≤50 words)", required: true, max_length: 280 },
      { id: "byline", type: "string", label: "Byline", required: false, max_length: 32 },
      { id: "emphasis", type: "array", label: "Up to 5 words to emphasise", required: false },
    ],
  },
  {
    id: "chart_moment",
    tier: "instant",
    specFormat: "chart_moment",
    title: "Chart Moment",
    description: "Animated price line + callout from backend market data snapshotted into the deal. 10 s.",
    styles: [], // from templates/<id>/template.json
    aspects: ALL_ASPECTS,
    prices: { 10: usdc(5) },
    etaS: 75,
    heroMs: { 10: 7500 },
    templateId: "chart_moment",
    defaultDelivery: "public",
    hidden: false,
    renderable: false,
    params: [
      STYLE,
      { id: "asset", type: "string", label: '"ETH" or "base:0x…"', required: true, max_length: 80 },
      { id: "window", type: "enum", label: "Window", required: true, options: ["24h", "7d", "30d", "90d", "1y"] },
      { id: "callout", type: "string", label: "Callout", required: false, max_length: 40 },
      { id: "mark", type: "enum", label: "Mark", required: false, options: ["change", "high", "low", "none"] },
    ],
  },
  {
    id: "studio_sting",
    tier: "studio",
    specFormat: "studio_sting",
    title: "Studio Sting (human)",
    description: "Bespoke 6–10 s logo/brand sting by Keyframe's designer. Preview within 48 h, then 24 h review.",
    styles: ["bespoke"],
    aspects: ALL_ASPECTS,
    prices: { 10: usdc(25) },
    etaS: 48 * 3600,
    heroMs: { 10: 0 },
    templateId: null,
    defaultDelivery: "public",
    hidden: false,
    renderable: false,
    params: [
      { id: "deliverable", type: "enum", label: "Studio deliverable", required: true, options: ["studio_sting"] },
      { id: "brief", type: "string", label: "Brief (40–2000 chars)", required: true, max_length: 2000 },
      { id: "references", type: "array", label: "Up to 5 https reference links", required: false },
      { id: "brand_assets_url", type: "url", label: "https link to brand assets", required: false },
    ],
  },
  {
    id: "studio_spot",
    tier: "studio",
    specFormat: "studio_spot",
    title: "Studio Spot (human)",
    description: "Bespoke 15–20 s piece with a style frame first. Preview within 72 h, then 24 h review.",
    styles: ["bespoke"],
    aspects: ALL_ASPECTS,
    prices: { 20: usdc(50) },
    etaS: 72 * 3600,
    heroMs: { 20: 0 },
    templateId: null,
    defaultDelivery: "public",
    hidden: false,
    renderable: false,
    params: [
      { id: "deliverable", type: "enum", label: "Studio deliverable", required: true, options: ["studio_spot"] },
      { id: "brief", type: "string", label: "Brief (40–2000 chars)", required: true, max_length: 2000 },
      { id: "references", type: "array", label: "Up to 5 https reference links", required: false },
      { id: "brand_assets_url", type: "url", label: "https link to brand assets", required: false },
    ],
  },
  {
    id: "probe",
    tier: "instant",
    specFormat: "catalog",
    title: "Probe",
    description: "2 s synthetic-monitoring test card (format: catalog, catalog_id: probe).",
    styles: [], // from templates/<id>/template.json
    aspects: ["9:16"],
    prices: { 2: usdc(0, 10) },
    etaS: 30,
    heroMs: { 2: 1000 },
    templateId: "probe",
    defaultDelivery: "public",
    hidden: true,
    renderable: false,
    params: [],
  },
];

/** Instant items take styles, hero frames and readiness from their template; Studio items are always sellable. */
function withTemplate(item: CatalogItem): CatalogItem {
  if (!item.templateId) return { ...item, renderable: true };
  const t = TEMPLATES[item.templateId];
  const heroMs: Record<number, number> = {};
  for (const d of Object.keys(item.prices).map(Number)) {
    const s = t?.heroTime[String(d)];
    heroMs[d] = typeof s === "number" ? Math.round(s * 1000) : (item.heroMs[d] ?? 0);
  }
  return { ...item, styles: t?.styles ?? [], heroMs, renderable: isRenderable(t) };
}

export const CATALOG: readonly CatalogItem[] = BASE.map(withTemplate);

export const catalogItem = (id: string): CatalogItem | undefined => CATALOG.find((i) => i.id === id);

/** Fixed-point display of atomic USDC with at least two decimals ("4.00", "0.10", "1.234567"). */
export function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

export const ASPECT_SIZE: Readonly<Record<Aspect, { width: number; height: number }>> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

export const FPS = 30;
