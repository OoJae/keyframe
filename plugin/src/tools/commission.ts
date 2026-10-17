// The two payment tools. Both re-run every quote check (§8) against a freshly fetched quote, including the live
// 402, and return ONLY the starter's strict proposal (structuredContent); all guidance goes in content[0].text.
// Any failed check returns isError with no proposal.

import { encodeFunctionData } from "viem";
import { getQuote } from "../core/api.js";
import { checkLines } from "../core/checks.js";
import { loadConfig } from "../core/config.js";
import { Budget } from "../core/net.js";
import { orderUrl } from "../core/probe.js";
import { MIN_QUOTE_LEFT_S, type QuoteReview, reviewQuote } from "../core/quote.js";
import { guarded, NOTHING_PROPOSED, ToolError, type ToolResult } from "../core/result.js";
import { eth, isoSeconds, nowSeconds, shortAddr, usdc, utc } from "../core/text.js";
import { MIN_GAS_WEI } from "../core/wallet.js";
import { proposeEvm, proposeX402 } from "../paybox.js";
import { CAIP2, erc20Abi, USDC } from "../protocol/index.js";
import { CommissionInput, evmOutputSchema, x402OutputSchema } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";
import { MAINTENANCE_TEXT } from "./quote.js";

const PROPOSAL_TTL_S = 240;
const QUOTE_EXPIRY_MARGIN_S = 60;

async function prepare(quoteId: string, rail: "x402" | "direct"): Promise<{ review: QuoteReview; expiresAt: string }> {
  const cfg = loadConfig();
  if (cfg.maintenance) throw new ToolError(`${MAINTENANCE_TEXT} ${NOTHING_PROPOSED}`);
  const budget = new Budget();
  const quote = await getQuote(cfg, budget, quoteId, NOTHING_PROPOSED);
  if (quote.status === "paid") {
    throw new ToolError(
      `Quote ${quoteId} is already paid. Do not pay again: follow the earlier PayBox request with get_request, then use keyframe_status or keyframe_verify. ${NOTHING_PROPOSED}`,
    );
  }
  if (quote.status === "draft") {
    throw new ToolError(
      `Quote ${quoteId} is not final yet (its preview is rendering). Call keyframe_status with quote_id first. ${NOTHING_PROPOSED}`,
    );
  }
  if (quote.status !== "final")
    throw new ToolError(
      `Quote ${quoteId} is ${quote.status}; request a new quote with keyframe_quote. ${NOTHING_PROPOSED}`,
    );
  const now = nowSeconds();
  const review = await reviewQuote(cfg, budget, quote, { now, live: true, wallet: rail === "direct" });
  if (review.fatal.length > 0) {
    throw new ToolError(
      `Refusing to propose a payment for quote ${quoteId}; these independent checks failed:\n${checkLines(review.fatal)}\n${NOTHING_PROPOSED}`,
    );
  }
  if (!review.probe?.ok) throw new ToolError(`The live payment request could not be checked. ${NOTHING_PROPOSED}`);
  // Proposal expiry: at most 4 minutes, and at least 60 s before the quote itself expires.
  const expiry = Math.min(now + PROPOSAL_TTL_S, quote.quote_expires_at - QUOTE_EXPIRY_MARGIN_S);
  if (expiry < now + MIN_QUOTE_LEFT_S - QUOTE_EXPIRY_MARGIN_S) {
    throw new ToolError(`Quote ${quoteId} expires too soon to pay safely; request a new quote. ${NOTHING_PROPOSED}`);
  }
  return { review, expiresAt: isoSeconds(expiry) };
}

const withText = (result: ToolResult, text: string): ToolResult => ({ ...result, content: [{ type: "text", text }] });

export const commissionTool = defineTool({
  name: "keyframe_commission",
  ...COPY.keyframe_commission,
  inputSchema: CommissionInput,
  outputSchema: x402OutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: ({ quote_id }) =>
    guarded(async () => {
      const { review, expiresAt } = await prepare(quote_id, "x402");
      const cfg = loadConfig();
      const t = review.terms;
      const E = review.derived.escrow;
      const probe = review.probe as Extract<NonNullable<QuoteReview["probe"]>, { ok: true }>;
      const proposal = proposeX402({
        chain: CAIP2,
        url: orderUrl(cfg, quote_id),
        method: "POST",
        maxAmount: t.amount.toString(),
        expiresAt,
      });
      return withText(
        proposal,
        [
          `Payment prepared for Keyframe quote ${quote_id}: ${usdc(t.amount)} USDC on Base by x402 (gasless for you), paid into the sealed envelope ${E}, never to Keyframe's own wallet.`,
          `Checked by this plugin just now: the envelope address is recomputed from the deal (CREATE2), and the live payment request (x402 v${probe.version}, sha256 ${probe.sha256.slice(0, 18)}…) pays exactly ${usdc(t.amount)} USDC (${t.amount} atomic units) to it.`,
          `PayBox's approval window must show payee ${E} and ${usdc(t.amount)} USDC. If either differs, decline.`,
          `The studio can be paid only by publishing the key to your file on Base before ${utc(t.deadline)}; otherwise the USDC can only return to ${shortAddr(t.buyer)}, automatically.`,
          `Use the wallet_id of buyer wallet ${t.buyer}. After approval, poll get_request until it finishes; never call keyframe_commission twice for one quote. Then call keyframe_verify with mode "funding" and the paid response.`,
          `This proposal expires at ${expiresAt}. Nothing is signed or paid until you approve in PayBox.`,
        ].join("\n"),
      );
    }, NOTHING_PROPOSED),
});

export const commissionDirectTool = defineTool({
  name: "keyframe_commission_direct",
  ...COPY.keyframe_commission_direct,
  inputSchema: CommissionInput,
  outputSchema: evmOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: ({ quote_id }) =>
    guarded(async () => {
      const { review, expiresAt } = await prepare(quote_id, "direct");
      const t = review.terms;
      const E = review.derived.escrow;
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [E, t.amount] });
      const proposal = proposeEvm({ chain: CAIP2, to: USDC, value: "0", data, expiresAt });
      const w = review.route?.wallet;
      const ethWei = w?.eth_wei == null ? null : BigInt(w.eth_wei);
      const gas =
        ethWei === null
          ? "It needs a little ETH on Base for gas (the wallet balance could not be read)."
          : ethWei < MIN_GAS_WEI
            ? `WARNING: the buyer wallet has only ${eth(ethWei)} ETH on Base; this transaction needs a little ETH for gas, so it may fail until the wallet is topped up.`
            : `It needs a little ETH on Base for gas (the wallet has ${eth(ethWei)} ETH).`;
      const delegated =
        w?.kind === "delegated"
          ? " This wallet is in smart-account mode (EIP-7702), which is why the direct route is used."
          : "";
      return withText(
        proposal,
        [
          `Direct payment prepared for Keyframe quote ${quote_id}: one Base transaction calling USDC ${USDC} transfer(${E}, ${t.amount}) = ${usdc(t.amount)} USDC into the sealed envelope.${delegated}`,
          `PayBox's window shows "to" = the USDC contract ${USDC}, value 0, and raw calldata ${data}: selector 0xa9059cbb, then the envelope address and the amount in atomic units. Check that the envelope ${E} appears in the data.`,
          `Checked by this plugin just now: the envelope address is recomputed from the deal (CREATE2) and the order's live payment request names the same address and amount.`,
          gas,
          `Send it from the buyer wallet ${t.buyer} (its wallet_id): refunds can only go to that address. The studio can be paid only by publishing the key to your file before ${utc(t.deadline)}.`,
          `After approval, poll get_request to success, then call keyframe_verify {mode:"funding", quote_id:"${quote_id}", tx_hash:<the transaction hash>}. Never send this payment twice. This proposal expires at ${expiresAt}.`,
        ].join("\n"),
      );
    }, NOTHING_PROPOSED),
});
