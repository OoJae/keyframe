// Exact zod schemas of the 9-tool surface (frozen-interfaces.md §8), snapshotted to tool-catalog.json.
// Inputs: root type object, strict, every string capped. Outputs: the plugin's own results are strict; anything
// sourced from the backend (terms, catalog items, order records, typed data) is a loose record so the server can
// add fields after the upload lock. Proposal tools reuse the starter's strict proposal schemas (src/paybox.ts).

import * as z from "zod/v4";

/** Proposal tools return exactly the starter's strict proposal schemas (keyframe_commission: x402; keyframe_commission_direct and keyframe_refund: evm). */
export { evmOutputSchema, x402OutputSchema } from "./paybox.js";

// ---------- primitives ----------

export const AddressIn = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");
export const Bytes32In = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte hex value");
const Atomic = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, "expected an atomic decimal amount");
export const QuoteId = z
  .string()
  .regex(/^q_[1-9A-HJ-NP-Za-km-z]{22}$/, "expected q_ + 22 base58 characters")
  .describe("Keyframe quote id (q_ + 22 base58 characters), from keyframe_quote");
export const OrderId = z
  .string()
  .regex(/^o_[1-9A-HJ-NP-Za-km-z]{22}$/, "expected o_ + 22 base58 characters")
  .describe("Keyframe order id (o_ + 22 base58 characters), from the paid response");
export const AccessToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "expected 43 base64url characters")
  .describe("access_token from the paid response or keyframe_orders (private order details)");
const Signature = z.string().regex(/^0x[0-9a-fA-F]{2,2048}$/, "expected 0x-prefixed hex, at most 1 KiB");
const Https = z.url({ protocol: /^https$/ }).max(512);
const IsoTime = z.iso.datetime({ offset: true });
const Style = z.string().min(1).max(32).describe("style id from keyframe_styles");
const Uint = (max: number) => z.int().min(0).max(max);

export const TermsIn = z
  .object({
    buyer: AddressIn,
    seller: AddressIn,
    operator: AddressIn,
    token: AddressIn,
    amount: Atomic,
    dueAt: Uint(Number.MAX_SAFE_INTEGER),
    deadline: Uint(Number.MAX_SAFE_INTEGER),
    reviewWindow: Uint(4_294_967_295),
    slaFloorBps: Uint(65_535),
    killFeeBps: Uint(65_535),
    keyHash: Bytes32In,
    specHash: Bytes32In,
    contentHash: Bytes32In,
    salt: Bytes32In,
  })
  .strict()
  .describe("Terms v1 JSON exactly as in the quote (amount is atomic USDC)");

// ---------- keyframe_styles ----------

export const StylesInput = z
  .object({
    tier: z.enum(["instant", "studio"]).optional().describe("only this tier"),
    format: z
      .string()
      .regex(/^[a-z0-9_.-]{1,64}$/)
      .optional()
      .describe("only this format id, e.g. launch_sting"),
  })
  .strict();

// ---------- keyframe_quote (product-render-demo.md §A3) ----------

const Hex6 = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const Palette = z.union([
  z.enum(["void", "paper", "signal", "mono", "ember"]),
  z.object({ bg: Hex6, fg: Hex6, accent: Hex6 }).strict(),
]);

const LaunchSting = z
  .object({
    style: Style,
    wordmark: z.string().min(1).max(24),
    tagline: z.string().max(60).optional(),
    logo_url: Https.optional().describe("https PNG/WebP/SVG of the user's own logo, at most 2 MB"),
    duration_s: z.union([z.literal(6), z.literal(10)]).default(6),
  })
  .strict();
const Countdown = z
  .object({
    style: Style,
    label: z.string().min(1).max(32),
    target: IsoTime,
    cta: z.string().max(24).optional(),
    tz_label: z.string().max(12).optional(),
  })
  .strict();
const Holding = z
  .object({
    symbol: z.string().min(1).max(12),
    usd: z.number().nonnegative().max(1e15).optional(),
    change_24h: z.number().min(-1).max(1000).nullable(),
  })
  .strict();
const PortfolioPulse = z
  .object({
    style: Style,
    title: z.string().max(32).optional(),
    handle: z.string().max(24).optional(),
    display: z.enum(["percent_only", "values"]).default("percent_only"),
    as_of: IsoTime,
    portfolio: z
      .record(z.string().max(64), z.unknown())
      .optional()
      .describe("the get_portfolio result for the buyer address, passed through unchanged"),
    holdings: z.array(Holding).max(6).optional(),
  })
  .strict();
const KineticPost = z
  .object({
    style: Style,
    text: z.string().min(1).max(280),
    byline: z.string().max(32).optional(),
    emphasis: z.array(z.string().min(1).max(24)).max(5).optional(),
  })
  .strict();
const ChartMoment = z
  .object({
    style: Style,
    asset: z.string().min(1).max(80).describe('"ETH" or "base:0x…"'),
    window: z.enum(["24h", "7d", "30d", "90d", "1y"]),
    callout: z.string().max(40).optional(),
    mark: z.enum(["change", "high", "low", "none"]).default("change"),
  })
  .strict();
const StudioBrief = z
  .object({
    deliverable: z.enum(["studio_sting", "studio_spot"]),
    brief: z.string().min(40).max(2000),
    references: z.array(Https).max(5).optional(),
    brand_assets_url: Https.optional(),
  })
  .strict();
const CatalogValue = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number()])).max(64),
]);
const CatalogItem = z
  .object({
    catalog_id: z.string().regex(/^[a-z0-9_.-]{2,64}$/),
    values: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), CatalogValue),
  })
  .strict();

export const QUOTE_FORMATS = [
  "launch_sting",
  "countdown",
  "portfolio_pulse",
  "kinetic_post",
  "chart_moment",
  "studio",
  "catalog",
] as const;
export type QuoteFormat = (typeof QUOTE_FORMATS)[number];

/** Which params variant an object is (the variants are strict, so their required keys discriminate). */
export function paramsFormat(p: Record<string, unknown>): QuoteFormat | null {
  if ("catalog_id" in p) return "catalog";
  if ("deliverable" in p) return "studio";
  if ("wordmark" in p) return "launch_sting";
  if ("label" in p && "target" in p) return "countdown";
  if ("as_of" in p) return "portfolio_pulse";
  if ("text" in p) return "kinetic_post";
  if ("asset" in p && "window" in p) return "chart_moment";
  return null;
}

const MAX_PORTFOLIO_JSON = 32 * 1024;
const MAX_OPTIONS = 16;

export const QuoteInput = z
  .object({
    buyer: AddressIn.describe("address of the PayBox wallet that will pay (list_credentials → metadata.address)"),
    format: z.enum(QUOTE_FORMATS).describe("what to make; new formats added later use catalog"),
    aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
    palette: Palette.optional().describe("omit to use the style's own colors; never invent brand colors"),
    deadline_minutes: z
      .int()
      .min(5)
      .max(1440)
      .default(30)
      .describe("Instant only: minutes until the delivery deadline"),
    delivery: z.enum(["public", "private"]).optional().describe("default public; portfolio_pulse defaults to private"),
    receipt_end_card: z.boolean().default(true),
    sound: z.enum(["none", "studio"]).default("studio"),
    rights_confirmed: z
      .literal(true)
      .describe("the user owns or may use every name, logo and text supplied, and nothing depicts a real person"),
    params: z
      .union([LaunchSting, Countdown, PortfolioPulse, KineticPost, ChartMoment, StudioBrief, CatalogItem])
      .describe("typed fields of the chosen format only"),
    from_quote_id: QuoteId.optional().describe("re-quote with changes to an earlier quote"),
    options: z
      .record(z.string().regex(/^[a-z0-9_]{1,32}$/), z.union([z.string().max(200), z.number(), z.boolean()]))
      .optional()
      .describe("extra catalog options named by keyframe_styles"),
  })
  .strict()
  .superRefine((q, ctx) => {
    const kind = paramsFormat(q.params as Record<string, unknown>);
    if (kind !== q.format) {
      ctx.addIssue({ code: "custom", path: ["params"], message: `params do not match format ${q.format}` });
    }
    if (q.options && Object.keys(q.options).length > MAX_OPTIONS) {
      ctx.addIssue({ code: "custom", path: ["options"], message: `at most ${MAX_OPTIONS} options` });
    }
    const pf = (q.params as { portfolio?: unknown }).portfolio;
    if (pf !== undefined && JSON.stringify(pf).length > MAX_PORTFOLIO_JSON) {
      ctx.addIssue({ code: "custom", path: ["params", "portfolio"], message: "portfolio is larger than 32 KiB" });
    }
  });
export type QuoteInputT = z.infer<typeof QuoteInput>;

// ---------- payment, status, verify, refund, review, orders ----------

export const CommissionInput = z.object({ quote_id: QuoteId }).strict();

export const StatusInput = z
  .object({
    quote_id: QuoteId.optional(),
    order_id: OrderId.optional(),
    access_token: AccessToken.optional(),
    wait_s: z.int().min(0).max(6).default(0).describe("wait up to this many seconds for a change"),
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.quote_id === undefined) === (s.order_id === undefined)) {
      ctx.addIssue({ code: "custom", path: ["quote_id"], message: "give exactly one of quote_id or order_id" });
    }
  });

export const VerifyInput = z
  .object({
    mode: z
      .enum(["derive", "funding", "delivery"])
      .describe(
        "derive: offline escrow math; funding: is the money sealed; delivery: is the key published and the file intact",
      ),
    terms: TermsIn.optional(),
    factory: AddressIn.optional().describe("escrow factory address (required with terms in derive mode)"),
    vault_impl: AddressIn.optional(),
    terms_hash: Bytes32In.optional(),
    escrow: AddressIn.optional().describe("an escrow address to compare against the derivation"),
    quote_id: QuoteId.optional(),
    order_id: OrderId.optional(),
    access_token: AccessToken.optional(),
    paid_response: z
      .record(z.string().max(64), z.unknown())
      .optional()
      .describe("the paid response (or the whole get_request result) of keyframe_commission"),
    tx_hash: Bytes32In.optional().describe("transaction hash of a direct-rail payment"),
    k_buyer: Bytes32In.optional().describe("k_buyer of a private order (from the paid response or keyframe_orders)"),
    max_chunks: z.int().min(1).max(64).optional().describe("cap on encrypted chunks to download and check"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "derive" && (v.terms === undefined || v.factory === undefined)) {
      ctx.addIssue({ code: "custom", path: ["terms"], message: "derive needs terms and factory" });
    }
    const anyRef =
      v.terms !== undefined ||
      v.terms_hash !== undefined ||
      v.quote_id !== undefined ||
      v.order_id !== undefined ||
      v.paid_response !== undefined;
    if (v.mode !== "derive" && !anyRef) {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: "give paid_response, quote_id, order_id, terms or terms_hash",
      });
    }
  });
export type VerifyInputT = z.infer<typeof VerifyInput>;

export const RefundInput = z
  .object({
    action: z
      .enum(["refund", "sweep", "reject"])
      .describe("refund: after the deadline; sweep: late or extra funds; reject: Studio review rejection (buyer only)"),
    terms: TermsIn.optional(),
    factory: AddressIn.optional(),
    quote_id: QuoteId.optional(),
    order_id: OrderId.optional(),
    access_token: AccessToken.optional(),
    token: AddressIn.optional().describe("sweep only: asset to return (default the deal's USDC; 0x0…0 for ETH)"),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.terms === undefined && r.quote_id === undefined && r.order_id === undefined) {
      ctx.addIssue({ code: "custom", path: ["terms"], message: "give terms (+ factory), quote_id or order_id" });
    }
  });
export type RefundInputT = z.infer<typeof RefundInput>;

export const ReviewInput = z
  .object({
    order_id: OrderId,
    access_token: AccessToken,
    decision: z.enum(["accept", "changes", "reject"]),
    signature: Signature.optional().describe("the request_wallet_sign result for the typed data from the first call"),
    sig_deadline: z
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("message.deadline of that typed data"),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.signature === undefined) !== (r.sig_deadline === undefined)) {
      ctx.addIssue({ code: "custom", path: ["signature"], message: "give signature and sig_deadline together" });
    }
  });

export const OrdersInput = z
  .object({
    address: AddressIn.describe("the buyer wallet address"),
    message: z.string().min(1).max(2048).optional().describe("the sign-in message from the first call, unchanged"),
    signature: Signature.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if ((o.message === undefined) !== (o.signature === undefined)) {
      ctx.addIssue({ code: "custom", path: ["signature"], message: "give message and signature together" });
    }
  });

// ---------- outputs ----------

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Loose = z.record(z.string(), z.unknown());
const Text = (max: number) => z.string().max(max);

export const CheckOut = z
  .object({ id: Text(40), status: z.enum(["pass", "fail", "warn", "skip"]), detail: Text(400) })
  .strict();
export const NextOut = z.object({ tool: Text(64).nullable(), input: Loose, note: Text(800) }).strict();
const EnvelopeOut = z.enum(["NOT SEALED", "SEALED", "IN REVIEW", "KEY PUBLISHED", "RETURNED", "UNKNOWN"]);

export const DerivationOut = z
  .object({
    factory: Address,
    vault_impl: Address,
    vault_impl_source: z.enum(["argument", "factory_nonce_1"]),
    init_code_hash: Bytes32,
    salt: Bytes32,
    chain_id: z.literal(8453),
    formula: Text(400),
  })
  .strict();

const WalletOut = z
  .object({
    address: Address,
    kind: z.enum(["plain", "delegated", "contract", "unknown"]),
    delegate: Address.nullable(),
    usdc_atomic: Atomic.nullable(),
    eth_wei: Atomic.nullable(),
    shortfall_atomic: Atomic.nullable(),
    consistent: z.boolean(),
  })
  .strict();
const RouteOut = z
  .object({ kind: z.enum(["x402", "direct", "fund_first"]), reason: Text(600), wallet: WalletOut })
  .strict();

export const QuoteOut = z
  .object({
    quote_id: z.string(),
    quote_status: z.enum(["draft", "final", "paid", "expired", "cancelled"]),
    payable: z.boolean(),
    summary: Text(600),
    tier: z.enum(["instant", "studio"]),
    format: Text(64),
    price: z.object({ atomic: Atomic, usdc: Text(32) }).strict(),
    eta_s: z.int().min(0),
    quote_expires_at: z.int().min(0),
    deadline: z.int().min(0),
    deadline_utc: Text(40),
    preview: z
      .object({
        still_url: Text(600).nullable(),
        still_sha256: Bytes32.nullable(),
        video_url: Text(600).nullable(),
        frame_ms: z.int().min(0).nullable(),
      })
      .strict(),
    escrow: z
      .object({
        address: Address,
        code: z.enum(["none", "eip1167", "other"]).nullable(),
        balance_atomic: Atomic.nullable(),
        derivation: DerivationOut,
      })
      .strict(),
    terms: Loose,
    terms_hash: Bytes32,
    spec_hash: Bytes32,
    delivery: z.enum(["public", "private"]),
    route: RouteOut.nullable(),
    checks: z.array(CheckOut).max(40),
    disclosures: z.array(Text(500)).max(12),
    retry_after_ms: z.int().min(0),
    next: NextOut,
  })
  .strict();

export const OnchainOut = z
  .object({
    factory: Address,
    terms_hash: Bytes32,
    escrow: Address,
    status: z.enum(["None", "Open", "Delivered", "Released", "Refunded", "Cancelled", "Rejected"]).nullable(),
    escrow_code: z.enum(["none", "eip1167", "other"]).nullable(),
    escrow_balance_atomic: Atomic.nullable(),
    deadline: z.int().min(0).nullable(),
    delivered_at: z.int().min(0).nullable(),
    final_at: z.int().min(0).nullable(),
    key_published: z.boolean(),
    to_seller_atomic: Atomic.nullable(),
    to_buyer_atomic: Atomic.nullable(),
    rpcs_answered: z.int().min(0),
    rpcs_configured: z.int().min(0),
    consistent: z.boolean(),
  })
  .strict();

export const StylesOutput = z
  .object({
    source: z.enum(["live", "embedded"]),
    summary: Text(800),
    formats: z.array(z.looseObject({ id: Text(64) })).max(64),
    studio: Loose.nullable(),
    policy: Loose.nullable(),
    next: NextOut,
  })
  .strict();

export const StatusOutput = z
  .object({
    kind: z.enum(["quote", "order"]),
    envelope: EnvelopeOut,
    meaning: Text(300),
    summary: Text(800),
    quote: QuoteOut.nullable(),
    order: Loose.nullable(),
    onchain: OnchainOut.nullable(),
    poll_after_s: z.int().min(0).nullable(),
    next: NextOut,
  })
  .strict();

export const VerifyOutput = z
  .object({
    mode: z.enum(["derive", "funding", "delivery"]),
    verdict: z.enum(["verified", "partial", "failed"]),
    envelope: EnvelopeOut,
    summary: Text(800),
    terms_source: z.enum(["argument", "api", "none"]),
    terms_hash: Bytes32.nullable(),
    escrow: Address.nullable(),
    derivation: DerivationOut.nullable(),
    payout: z.object({ at_due: Atomic, at_deadline: Atomic }).strict().nullable(),
    checks: z.array(CheckOut).max(60),
    onchain: OnchainOut.nullable(),
    delivery: z
      .object({
        manifest_hash: Bytes32,
        chunks_total: z.int().min(0),
        chunks_verified: z.int().min(0),
        bytes_total: z.int().min(0),
        media: z.object({ width: z.int(), height: z.int(), duration_ms: z.int() }).strict().nullable(),
        manifest_url: Text(600),
      })
      .strict()
      .nullable(),
    next: NextOut.nullable(),
  })
  .strict();

export const ReviewOutput = z
  .object({
    stage: z.enum(["sign", "submitted"]),
    decision: z.enum(["accept", "changes", "reject"]),
    order_id: z.string(),
    typed_data: Loose.nullable(),
    sign_with: Text(200).nullable(),
    sig_deadline: z.int().min(0).nullable(),
    signer: Address.nullable(),
    tx: Text(80).nullable(),
    status: Text(64).nullable(),
    note: Text(800),
  })
  .strict();

export const OrdersOutput = z
  .object({
    stage: z.enum(["sign", "signed_in"]),
    address: Address,
    message: Text(2048).nullable(),
    sign_with: Text(200).nullable(),
    orders: z.array(Loose).max(50),
    note: Text(800),
    next: NextOut.nullable(),
  })
  .strict();
