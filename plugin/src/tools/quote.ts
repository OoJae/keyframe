import { getAddress } from "viem";
import { apiFailure, apiRequest, parseQuote } from "../core/api.js";
import { checkLines } from "../core/checks.js";
import { loadConfig } from "../core/config.js";
import { Budget } from "../core/net.js";
import { reviewQuote } from "../core/quote.js";
import { dataResult, errorResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { nowSeconds } from "../core/text.js";
import { quoteCard, quoteView } from "../core/views.js";
import { QuoteInput, QuoteOut } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

export const MAINTENANCE_TEXT =
  "Keyframe is paused for maintenance and is not taking new orders right now. Existing orders, keyframe_status, keyframe_verify and keyframe_refund still work.";

const QUOTE_CAP_MS = 4_000;

export const quoteTool = defineTool({
  name: "keyframe_quote",
  ...COPY.keyframe_quote,
  inputSchema: QuoteInput,
  outputSchema: QuoteOut,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: (input) =>
    guarded(async () => {
      const cfg = loadConfig();
      if (cfg.maintenance) throw new ToolError(MAINTENANCE_TEXT);
      const budget = new Budget();
      const buyer = getAddress(input.buyer);
      // §7: POST /v1/quotes body = the tool input (no plugin-only fields), with defaults applied.
      const res = await apiRequest(
        cfg,
        budget,
        "/v1/quotes",
        { method: "POST", body: { ...input, buyer }, capMs: QUOTE_CAP_MS },
        "Creating the quote",
      );
      if (res.status !== 200 && res.status !== 201) throw apiFailure(res, "No quote was created. No money moved.");
      const quote = parseQuote(res.json, "No money moved.");
      const review = await reviewQuote(cfg, budget, quote, {
        now: nowSeconds(),
        expectBuyer: buyer,
        live: true,
        wallet: true,
      });
      if (review.fatal.length > 0) {
        return errorResult(
          `Keyframe returned quote ${quote.quote_id}, but this plugin's independent checks failed, so it must not be paid:\n` +
            `${checkLines(review.fatal)}\nNo money moved. Ask for a new quote; if this repeats, Keyframe's service is misconfigured or compromised.`,
        );
      }
      const card = quoteCard(review);
      return dataResult(card, quoteView(review, card.split("\n")[0] ?? ""));
    }, NOTHING_MOVED),
});
