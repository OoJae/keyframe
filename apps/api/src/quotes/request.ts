import * as z from "zod/v4";

// POST /v1/quotes body = the plugin's keyframe_quote input minus plugin-only fields (frozen-interfaces.md §7,
// product-render-demo.md §A3). Top-level unknown keys are ignored so a frozen plugin that sends an extra field
// keeps working; per-format params are strict because they are hashed into the spec.

const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");
const Hex6 = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "expected #RRGGBB");
const Style = z.string().min(1).max(32);
const HttpsUrl = z.url({ protocol: /^https$/ }).max(512);

export const PALETTE_PRESETS = ["void", "paper", "signal", "mono", "ember"] as const;
const Palette = z.union([z.enum(PALETTE_PRESETS), z.strictObject({ bg: Hex6, fg: Hex6, accent: Hex6 })]);

export const LaunchStingParams = z.strictObject({
  style: Style,
  wordmark: z.string().min(1).max(24),
  tagline: z.string().max(60).optional(),
  logo_url: HttpsUrl.optional(),
  duration_s: z.union([z.literal(6), z.literal(10)]).default(6),
});

export const CountdownParams = z.strictObject({
  style: Style,
  label: z.string().min(1).max(32),
  target: z.iso.datetime({ offset: true }),
  cta: z.string().max(24).optional(),
  tz_label: z.string().max(12).optional(),
});

const Holding = z.strictObject({
  symbol: z.string().min(1).max(12),
  usd: z.number().nonnegative().optional(),
  change_24h: z.number().min(-1).max(1000).nullable(),
});

export const PortfolioPulseParams = z.strictObject({
  style: Style,
  title: z.string().max(32).optional(),
  handle: z.string().max(24).optional(),
  display: z.enum(["percent_only", "values"]).default("percent_only"),
  as_of: z.iso.datetime({ offset: true }),
  portfolio: z.json().optional(),
  holdings: z.array(Holding).max(6).optional(),
});

export const KineticPostParams = z.strictObject({
  style: Style,
  text: z.string().min(1).max(280),
  byline: z.string().max(32).optional(),
  emphasis: z.array(z.string().min(1).max(24)).max(5).optional(),
});

export const ChartMomentParams = z.strictObject({
  style: Style,
  asset: z.string().min(1).max(80),
  window: z.enum(["24h", "7d", "30d", "90d", "1y"]),
  callout: z.string().max(40).optional(),
  mark: z.enum(["change", "high", "low", "none"]).default("change"),
});

export const StudioParams = z.strictObject({
  deliverable: z.enum(["studio_sting", "studio_spot"]),
  brief: z.string().min(40).max(2000),
  references: z.array(HttpsUrl).max(5).optional(),
  brand_assets_url: HttpsUrl.optional(),
});

export const CatalogParams = z.strictObject({
  catalog_id: z.string().regex(/^[a-z0-9_.-]{2,64}$/),
  values: z.record(z.string().max(64), z.json()),
});

export const REQUEST_FORMATS = [
  "launch_sting",
  "countdown",
  "portfolio_pulse",
  "kinetic_post",
  "chart_moment",
  "studio",
  "catalog",
] as const;
export type RequestFormat = (typeof REQUEST_FORMATS)[number];

const PARAMS: Record<RequestFormat, z.ZodType> = {
  launch_sting: LaunchStingParams,
  countdown: CountdownParams,
  portfolio_pulse: PortfolioPulseParams,
  kinetic_post: KineticPostParams,
  chart_moment: ChartMomentParams,
  studio: StudioParams,
  catalog: CatalogParams,
};

const Attest = z.object({ brand_rights: z.literal(true), no_real_person_likeness: z.literal(true) });

const QuoteEnvelope = z.object({
  buyer: Addr,
  tier: z.enum(["instant", "studio"]).optional(),
  format: z.enum(REQUEST_FORMATS),
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
  palette: Palette.optional(),
  deadline_minutes: z.int().min(5).max(1440).default(30),
  delivery: z.enum(["public", "private"]).optional(),
  receipt_end_card: z.boolean().default(true),
  sound: z.enum(["none", "studio"]).default("studio"),
  // Rights attestation: the A3 field, or the architecture.md §c.1 spellings (any one form suffices).
  rights_confirmed: z.literal(true).optional(),
  attest: Attest.optional(),
  attest_brand_rights: z.literal(true).optional(),
  attest_no_real_person_likeness: z.literal(true).optional(),
  notes: z.string().max(2000).optional(),
  params: z.record(z.string().max(64), z.unknown()),
});

export type LaunchSting = z.infer<typeof LaunchStingParams>;
export type Countdown = z.infer<typeof CountdownParams>;
export type PortfolioPulse = z.infer<typeof PortfolioPulseParams>;
export type KineticPost = z.infer<typeof KineticPostParams>;
export type ChartMoment = z.infer<typeof ChartMomentParams>;
export type Studio = z.infer<typeof StudioParams>;
export type CatalogValues = z.infer<typeof CatalogParams>;

export type QuoteParams =
  | { format: "launch_sting"; params: LaunchSting }
  | { format: "countdown"; params: Countdown }
  | { format: "portfolio_pulse"; params: PortfolioPulse }
  | { format: "kinetic_post"; params: KineticPost }
  | { format: "chart_moment"; params: ChartMoment }
  | { format: "studio"; params: Studio }
  | { format: "catalog"; params: CatalogValues };

export type Palette = z.infer<typeof Palette>;

export type QuoteRequest = QuoteParams & {
  buyer: string;
  tier?: "instant" | "studio";
  aspect: "9:16" | "1:1" | "16:9";
  palette?: Palette;
  deadlineMinutes: number;
  delivery?: "public" | "private";
  receiptEndCard: boolean;
  sound: "none" | "studio";
  notes?: string;
};

export type Issue = { path: string; message: string };
export type ParseResult = { ok: true; request: QuoteRequest } | { ok: false; error: string; issues: Issue[] };

const issuesOf = (e: z.ZodError, prefix: string[] = []): Issue[] =>
  e.issues.slice(0, 20).map((i) => ({ path: [...prefix, ...i.path.map(String)].join("."), message: i.message }));

export function parseQuoteRequest(body: unknown): ParseResult {
  const env = QuoteEnvelope.safeParse(body);
  if (!env.success) return { ok: false, error: "invalid_request", issues: issuesOf(env.error) };
  const e = env.data;
  const attested =
    e.rights_confirmed === true ||
    e.attest !== undefined ||
    (e.attest_brand_rights === true && e.attest_no_real_person_likeness === true);
  if (!attested) {
    return {
      ok: false,
      error: "rights_not_confirmed",
      issues: [{ path: "rights_confirmed", message: "confirm brand rights and no real-person likeness" }],
    };
  }
  const p = PARAMS[e.format].safeParse(e.params);
  if (!p.success) return { ok: false, error: "invalid_params", issues: issuesOf(p.error, ["params"]) };
  const request = {
    format: e.format,
    params: p.data,
    buyer: e.buyer,
    aspect: e.aspect,
    deadlineMinutes: e.deadline_minutes,
    receiptEndCard: e.receipt_end_card,
    sound: e.sound,
    ...(e.tier !== undefined && { tier: e.tier }),
    ...(e.palette !== undefined && { palette: e.palette }),
    ...(e.delivery !== undefined && { delivery: e.delivery }),
    ...(e.notes !== undefined && { notes: e.notes }),
  } as QuoteRequest;
  return { ok: true, request };
}
