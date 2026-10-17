import { EMBEDDED_AS_OF, EMBEDDED_FORMATS, EMBEDDED_POLICY } from "../catalog.js";
import { apiRequest } from "../core/api.js";
import { loadConfig } from "../core/config.js";
import { Budget } from "../core/net.js";
import { dataResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { keyframeUrl } from "../core/still.js";
import { capJson, capRecord, capRecords, clean, quoted } from "../core/text.js";
import { StylesInput, StylesOutput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

type Format = { id: string; [k: string]: unknown };

const MAX_FORMATS = 64;
const CATALOG_CAPS = { maxString: 500, maxArray: MAX_FORMATS, maxKeys: 40, maxDepth: 6 };
/** L1: per-entry and whole-catalog size caps, so the result stays well under the 256 KiB stdout limit. */
const MAX_ENTRY_BYTES = 32 * 1024;
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_SIDE_BYTES = 16 * 1024;

function liveFormats(json: unknown): { formats: Format[]; studio: unknown; policy: unknown } | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  if (!Array.isArray(j.formats)) return null;
  const formats = capRecords(
    j.formats
      .slice(0, MAX_FORMATS)
      .map((f) => capJson(f, CATALOG_CAPS))
      .filter(
        (f): f is Format =>
          typeof f === "object" &&
          f !== null &&
          !Array.isArray(f) &&
          typeof (f as Format).id === "string" &&
          /^[a-z0-9_.-]{1,64}$/.test((f as Format).id),
      ),
    MAX_ENTRY_BYTES,
    MAX_CATALOG_BYTES,
  );
  if (formats.length === 0 && j.formats.length > 0) return null; // every entry unreadable or oversized
  const obj = (v: unknown) => {
    const c =
      typeof v === "object" && v !== null && !Array.isArray(v) ? capRecord(v, CATALOG_CAPS, MAX_SIDE_BYTES) : null;
    return typeof c === "object" ? c : null;
  };
  return { formats, studio: obj(j.studio), policy: obj(j.policy) };
}

/** A backend price like "4.00" (anything else is not shown). */
const priceText = (p: unknown): string | null =>
  typeof p === "string" && /^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(p) ? p : null;

export const stylesTool = defineTool({
  name: "keyframe_styles",
  ...COPY.keyframe_styles,
  inputSchema: StylesInput,
  outputSchema: StylesOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: (input) =>
    guarded(async () => {
      const cfg = loadConfig();
      const budget = new Budget();
      const qs = new URLSearchParams();
      if (input.tier) qs.set("tier", input.tier);
      if (input.format) qs.set("format", input.format);
      const path = `/v1/styles${qs.size > 0 ? `?${qs.toString()}` : ""}`;

      let live: ReturnType<typeof liveFormats> = null;
      let why = "";
      try {
        const res = await apiRequest(cfg, budget, path, {}, "Keyframe's catalog");
        live = res.status === 200 ? liveFormats(res.json) : null;
        if (!live)
          why = res.status === 200 ? "the live catalog was unreadable" : `the live catalog returned HTTP ${res.status}`;
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        why = error.message.replace(/\.$/, "");
      }

      const match = (f: Format) => (!input.tier || f.tier === input.tier) && (!input.format || f.id === input.format);
      const source = live ? "live" : "embedded";
      const formats = (live ? live.formats : (EMBEDDED_FORMATS as unknown as Format[])).filter(match);
      // M1: backend strings are quoted; prices are shown only when they look like prices.
      const lines = formats.slice(0, 12).map((f) => {
        const price = (
          typeof f.price_usdc === "object" && f.price_usdc !== null
            ? Object.values(f.price_usdc as Record<string, unknown>)
            : [f.price_usdc]
        )
          .map(priceText)
          .filter((p): p is string => p !== null)
          .slice(0, 6)
          .join(" / ");
        const line = `- ${f.id}: ${quoted(f.title ?? f.id, 60)}${price ? `, ${price} USDC` : ""}${f.availability ? ` (${quoted(f.availability, 30)})` : ""}`;
        // A sample video link only on Keyframe's own hosts (the preview-still guard), quoted as data.
        const sample = typeof f.sample_url === "string" ? keyframeUrl(cfg, f.sample_url) : null;
        return sample ? `${line}\n  sample: ${quoted(sample, 600)}` : line;
      });
      const head = live
        ? `Keyframe catalog (live, ${formats.length} formats). Prices are in USDC on Base; the quote is authoritative.`
        : `Keyframe catalog (embedded snapshot of ${EMBEDDED_AS_OF}, because ${why}). Live prices may differ; the quote is authoritative.`;
      const summary = `${head}\n${lines.join("\n")}${formats.length === 0 ? "\n(no format matches this filter)" : ""}`;
      return dataResult(summary, {
        source,
        summary: clean(head, 800),
        formats,
        studio: (live?.studio as Record<string, unknown> | null) ?? null,
        policy: (live?.policy as Record<string, unknown> | null) ?? (live ? null : EMBEDDED_POLICY),
        next: {
          tool: "keyframe_quote",
          input: {},
          note: "Quote with the buyer wallet address, the format, and only the typed params the user gave.",
        },
      });
    }, NOTHING_MOVED),
});
