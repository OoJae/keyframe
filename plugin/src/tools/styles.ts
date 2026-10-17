import { EMBEDDED_AS_OF, EMBEDDED_FORMATS, EMBEDDED_POLICY } from "../catalog.js";
import { apiRequest } from "../core/api.js";
import { loadConfig } from "../core/config.js";
import { Budget } from "../core/net.js";
import { dataResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { capJson, clean } from "../core/text.js";
import { StylesInput, StylesOutput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

type Format = { id: string; [k: string]: unknown };

const MAX_FORMATS = 64;

function liveFormats(json: unknown): { formats: Format[]; studio: unknown; policy: unknown } | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const j = capJson(json, { maxString: 500, maxArray: MAX_FORMATS, maxKeys: 40, maxDepth: 6 }) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(j.formats)) return null;
  const formats = j.formats.filter(
    (f): f is Format =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as Format).id === "string" &&
      /^[a-z0-9_.-]{1,64}$/.test((f as Format).id),
  );
  const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : null);
  return { formats, studio: obj(j.studio), policy: obj(j.policy) };
}

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
      const lines = formats.slice(0, 12).map((f) => {
        const price =
          typeof f.price_usdc === "object" && f.price_usdc !== null
            ? Object.values(f.price_usdc as Record<string, unknown>)
                .map((p) => clean(p, 12))
                .join(" / ")
            : clean(f.price_usdc ?? "", 24);
        return `- ${clean(f.id, 64)}: ${clean(f.title ?? f.id, 60)}${price ? `, ${price} USDC` : ""}${f.availability ? ` (${clean(f.availability, 30)})` : ""}`;
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
