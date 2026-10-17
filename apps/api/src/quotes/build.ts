import {
  deriveKBuyer,
  deriveKChain,
  escrowOf,
  hashTerms,
  type JsonValue,
  jcs,
  keyHashOf,
  MIN_AMOUNT,
  type Spec,
  SpecSchema,
  saltOf,
  sha256Hex,
  specHash,
  type Terms,
} from "@keyframe/protocol";
import { type Address, getAddress, type Hex, hexToBytes } from "viem";
import { type Aspect, CATALOG, type CatalogItem, catalogItem, type SpecFormat } from "../catalog.js";
import type { Config } from "../config.js";
import { wordCount } from "./policy.js";
import type { QuoteRequest } from "./request.js";

// Pure quote assembly: catalog lookup + pricing (plan), then keys (§4), spec (§6) and Terms (§1).

export const ZERO32 = `0x${"0".repeat(64)}` as Hex;
export const PUBLIC_K_BUYER = ZERO32;

export type PlanError = { ok: false; status: number; error: string; detail: string };

export interface QuotePlan {
  item: CatalogItem;
  tier: "instant" | "studio";
  specFormat: SpecFormat;
  style: string;
  aspect: Aspect;
  durationS: number;
  heroMs: number;
  amount: bigint;
  delivery: "public" | "private";
  /** JCS-safe params as they enter the spec. */
  specParams: Record<string, JsonValue>;
  /** Content-addressed data snapshot (portfolio), or null. */
  dataSnapshot: JsonValue | null;
  deadlineMinutes: number;
}

const KINETIC_DURATIONS: readonly [number, number][] = [
  [12, 6],
  [22, 9],
  [34, 12],
  [50, 15],
];

/** Recursively makes a JSON value JCS-compatible: non-integer / unsafe numbers become their ES string form. */
export function specSafe(v: unknown): JsonValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : String(v);
  if (Array.isArray(v)) return v.map(specSafe);
  if (typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = specSafe(x);
    return out;
  }
  throw new TypeError(`unsupported value of type ${typeof v}`);
}

const fail = (status: number, error: string, detail: string): PlanError => ({ ok: false, status, error, detail });

function itemFor(r: QuoteRequest): CatalogItem | PlanError {
  const id = r.format === "studio" ? r.params.deliverable : r.format === "catalog" ? r.params.catalog_id : r.format;
  const item = catalogItem(id);
  if (!item) return fail(400, "unknown_format", `no catalog entry "${id}"`);
  if (r.format === "catalog" && item.specFormat !== "catalog") {
    return fail(400, "unknown_format", `"${id}" is not a catalog-only entry; use format "${id}"`);
  }
  return item;
}

export function planQuote(r: QuoteRequest, cfg: Config, nowS?: number): ({ ok: true } & QuotePlan) | PlanError {
  const found = itemFor(r);
  if ("ok" in found) return found;
  const item = found;
  if (cfg.formatsDisabled.has(item.id) || !item.renderable) {
    const open = CATALOG.filter((i) => !i.hidden && i.renderable && !cfg.formatsDisabled.has(i.id)).map((i) => i.id);
    return fail(422, "format_unavailable", `${item.id} is not available yet; available now: ${open.join(", ")}`);
  }
  if (r.tier && r.tier !== item.tier) return fail(400, "tier_mismatch", `${item.id} is a ${item.tier} format`);
  if (!item.aspects.includes(r.aspect)) return fail(400, "unsupported_aspect", `${item.id} supports ${item.aspects}`);

  let style: string;
  let durationS: number;
  let raw: Record<string, unknown>;
  let dataSnapshot: JsonValue | null = null;
  switch (r.format) {
    case "studio":
      style = "bespoke";
      durationS = Number(Object.keys(item.prices)[0]);
      raw = { ...r.params };
      break;
    case "catalog":
      style = item.styles[0] ?? item.id;
      durationS = Number(Object.keys(item.prices)[0]);
      raw = { catalog_id: r.params.catalog_id, values: r.params.values };
      break;
    default: {
      style = r.params.style;
      if (!item.styles.includes(style)) {
        // Agents often cannot see why a quote failed (a host may report only "failed"), so a format with a single
        // style, or a placeholder such as "default", resolves to the format's own style. The quote shows the style
        // used and the buyer previews it before paying. A format with several styles still refuses an unknown one.
        const placeholder = /^(default|auto|any|standard|basic|none)$/i.test(style.trim());
        const only = item.styles.length === 1 ? item.styles[0] : undefined;
        const fallback = only ?? (placeholder ? item.styles[0] : undefined);
        if (fallback === undefined) {
          return fail(400, "unknown_style", `${item.id} styles: ${item.styles.join(", ")}`);
        }
        style = fallback;
      }
      if (r.format === "launch_sting") durationS = r.params.duration_s;
      else if (r.format === "kinetic_post") {
        const words = wordCount(r.params.text);
        durationS = KINETIC_DURATIONS.find(([max]) => words <= max)?.[1] ?? 0;
        if (durationS === 0) return fail(422, "content_policy", "kinetic_post text is limited to 50 words");
      } else durationS = Number(Object.keys(item.prices)[0]);
      const rest: Record<string, unknown> = { ...r.params };
      // Countdown frames depend on "time left"; anchor them to quote time so the render is reproducible from the spec.
      if (r.format === "countdown" && nowS !== undefined)
        rest.as_of = new Date(nowS * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      if (r.format === "portfolio_pulse" && rest.portfolio !== undefined) {
        dataSnapshot = specSafe(rest.portfolio);
        delete rest.portfolio;
      }
      raw = rest;
    }
  }
  const price = item.prices[durationS];
  if (price === undefined)
    return fail(400, "unsupported_duration", `${item.id} durations: ${Object.keys(item.prices)}`);
  if (price < MIN_AMOUNT || price > cfg.maxAmount) {
    return fail(503, "format_unavailable", `${item.id} price is outside this deployment's cap`);
  }

  const render: Record<string, unknown> = { sound: r.sound, receipt_end_card: r.receiptEndCard };
  if (r.palette !== undefined) render.palette = r.palette;
  const specParams = specSafe({ ...raw, ...(item.tier === "instant" ? render : {}) }) as Record<string, JsonValue>;

  return {
    ok: true,
    item,
    tier: item.tier,
    specFormat: item.specFormat,
    style,
    aspect: r.aspect,
    durationS,
    heroMs: item.heroMs[durationS] ?? 0,
    amount: price,
    delivery: r.delivery ?? item.defaultDelivery,
    specParams,
    dataSnapshot,
    deadlineMinutes: r.deadlineMinutes,
  };
}

export interface QuoteKeys {
  kChain: Hex;
  kBuyer: Hex;
  keyHash: Hex;
  kBuyerHash: Hex | null;
  salt: Hex;
}

export async function deriveQuoteKeys(kmaster: Uint8Array, quoteId: string, private_: boolean): Promise<QuoteKeys> {
  const kChain = await deriveKChain(kmaster, quoteId);
  const kBuyer = private_ ? await deriveKBuyer(kmaster, quoteId) : PUBLIC_K_BUYER;
  return {
    kChain,
    kBuyer,
    keyHash: keyHashOf(kChain),
    kBuyerHash: private_ ? await sha256Hex(hexToBytes(kBuyer)) : null,
    salt: saltOf(quoteId),
  };
}

export interface SpecInputs {
  plan: QuotePlan;
  seller: Address;
  kBuyerHash: Hex | null;
  dataSnapshotSha256: Hex | null;
  template: { id: string; version: string; hash: Hex };
  renderer: { name: string; version: string };
  keyframe: { stillSha256: Hex; atMs: number } | null;
}

export function buildSpec(i: SpecInputs): Spec {
  return SpecSchema.parse({
    v: 1,
    studio: getAddress(i.seller),
    tier: i.plan.tier,
    format: i.plan.specFormat,
    style: i.plan.style,
    aspect: i.plan.aspect,
    durationS: i.plan.durationS,
    params: i.plan.specParams,
    template: i.template,
    renderer: i.renderer,
    keyframe: i.keyframe,
    delivery: i.plan.delivery,
    kBuyerHash: i.kBuyerHash,
    dataSnapshotSha256: i.dataSnapshotSha256,
  });
}

/** Spec placeholders until the worker reports what actually rendered (Instant) or for human work (Studio). */
export function initialTemplate(plan: QuotePlan) {
  return plan.tier === "studio"
    ? { template: { id: "studio", version: "1", hash: ZERO32 }, renderer: { name: "studio", version: "1" } }
    : {
        template: { id: plan.item.templateId ?? plan.item.id, version: "pending", hash: ZERO32 },
        renderer: { name: "hyperframes", version: "pending" },
      };
}

export interface TermsInputs {
  buyer: Address;
  seller: Address;
  operator: Address;
  token: Address;
  amount: bigint;
  deadline: number;
  reviewWindow: number;
  killFeeBps: number;
  keyHash: Hex;
  specHash: Hex;
  contentHash: Hex;
  salt: Hex;
}

export function buildTerms(i: TermsInputs): Terms {
  return {
    buyer: getAddress(i.buyer),
    seller: getAddress(i.seller),
    operator: getAddress(i.operator),
    token: getAddress(i.token),
    amount: i.amount,
    dueAt: 0,
    deadline: i.deadline,
    reviewWindow: i.reviewWindow,
    slaFloorBps: 10_000,
    killFeeBps: i.killFeeBps,
    keyHash: i.keyHash,
    specHash: i.specHash,
    contentHash: i.contentHash,
    salt: i.salt,
  };
}

export interface Sealed {
  spec: Spec;
  specHash: Hex;
  terms: Terms;
  termsHash: Hex;
  escrow: Address;
}

/** spec → specHash → Terms → termsHash → E, all under the configured factory. */
export async function seal(spec: Spec, t: Omit<TermsInputs, "specHash">, cfg: Config): Promise<Sealed> {
  const sh = await specHash(spec);
  const terms = buildTerms({ ...t, specHash: sh });
  const termsHash = hashTerms(terms, cfg.factory);
  return { spec, specHash: sh, terms, termsHash, escrow: escrowOf(termsHash, cfg.factory, cfg.vaultImpl) };
}

export const snapshotHash = (s: JsonValue): Promise<Hex> => sha256Hex(jcs(s));
