// Money tools for spikes S2/S4/S5/S8/S9/S10. Each returns exactly one unsigned proposal, or isError with no proposal.

import type { McpServer } from "@modelcontextprotocol/server";
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import * as z from "zod/v4";

import { ADDRESS, ATOMIC, BASE_CHAIN, BASE_USDC, HARD_MAX_AMOUNT, MIN_AMOUNT, QUOTE_ID, resolveApiBase, usdc } from "../config.js";
import { Budget, boundedFetch, NetError, readTextCapped } from "../net.js";
import { evmOutputSchema, proposeEvm, proposeX402, x402OutputSchema } from "../paybox.js";
import { parseChallenge } from "../x402parse.js";

const Quote = z.object({
  quote_id: z.string().regex(QUOTE_ID),
  pay_to: z.string().regex(ADDRESS),
  amount: z.string().regex(ATOMIC),
  buyer: z.string().regex(ADDRESS),
  pay_to_index: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
}).passthrough();
type Quote = z.infer<typeof Quote>;

const input = z.object({ quote_id: z.string().regex(QUOTE_ID).describe("Keyframe spike quote id, q_ followed by 22 base58 characters") }).strict();

class ToolFailure extends Error {}

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

function describeNet(error: unknown, what: string): string {
  if (error instanceof NetError) return `${what} failed (${error.kind}${error.cause_code ? `, ${error.cause_code}` : ""}). Nothing was proposed; check the spike API and try again.`;
  return `${what} failed. Nothing was proposed.`;
}

async function loadQuote(base: string, quoteId: string, budget: Budget): Promise<Quote> {
  let res: Response;
  let text: string;
  try {
    res = await boundedFetch(`${base}/v1/quotes/${quoteId}`, { method: "GET", headers: { accept: "application/json" } }, budget, 3_500);
    text = await readTextCapped(res, 16 * 1024);
  } catch (error) {
    throw new ToolFailure(describeNet(error, "Fetching the quote"));
  }
  if (res.status === 404) throw new ToolFailure(`Quote ${quoteId} does not exist on the spike API. Ask the builder for a fresh quote id.`);
  if (!res.ok) throw new ToolFailure(`The spike API returned HTTP ${res.status} for quote ${quoteId}. Nothing was proposed.`);
  let parsed;
  try {
    parsed = Quote.safeParse(JSON.parse(text));
  } catch {
    throw new ToolFailure("The spike API returned a non-JSON quote. Nothing was proposed.");
  }
  if (!parsed.success) throw new ToolFailure("The spike API returned a malformed quote. Nothing was proposed.");
  const quote = parsed.data;
  if (quote.quote_id !== quoteId) throw new ToolFailure("The spike API returned a different quote id than requested. Nothing was proposed.");
  const amount = BigInt(quote.amount);
  if (amount < MIN_AMOUNT || amount > HARD_MAX_AMOUNT) {
    throw new ToolFailure(`Quote amount ${quote.amount} atomic USDC is outside the plugin's bounds (0.10 to 50 USDC). Nothing was proposed.`);
  }
  if (quote.status && quote.status !== "awaiting_payment") {
    throw new ToolFailure(`Quote ${quoteId} is ${quote.status}; it cannot be paid again. Check the earlier PayBox request with get_request instead.`);
  }
  return quote;
}

export function registerCommissionTools(server: McpServer): void {
  server.registerTool(
    "keyframe_commission",
    {
      title: "Keyframe spike: pay a test quote over x402",
      description:
        "Prepares the one-tap x402 USDC payment (Base) for a Keyframe spike test quote. Input: quote_id from the builder. " +
        "Fetches the quote, pre-fetches the live 402 challenge from POST /v1/orders/{quote_id}, checks that it is a single exact USDC challenge on Base whose payee and amount equal the quote, " +
        "then returns one unsigned x402 proposal for PayBox approval. Pass wallet_id in use_plugin when several wallets are granted. " +
        "After approval, poll get_request with the returned request id; never call this tool again to poll. Amounts are atomic USDC (100000 = 0.10 USDC).",
      inputSchema: input,
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id }) => {
      try {
        const budget = new Budget(8_500);
        const { base } = resolveApiBase();
        const quote = await loadQuote(base, quote_id, budget);
        const url = `${base}/v1/orders/${quote_id}`;
        let res: Response;
        let bodyText: string;
        try {
          // Same shape as PayBox's unpaid probe: POST, no body.
          res = await boundedFetch(url, { method: "POST", headers: { accept: "application/json" } }, budget, 3_500);
          bodyText = await readTextCapped(res, 64 * 1024);
        } catch (error) {
          return fail(describeNet(error, "Pre-fetching the 402 challenge"));
        }
        if (res.status === 409) return fail(`Quote ${quote_id} is already paid (HTTP 409). Check the earlier PayBox request with get_request; do not pay again.`);
        const parsed = parseChallenge(res.status, res.headers.get("payment-required"), bodyText);
        if (!parsed.ok) return fail(`The order URL did not return a usable x402 challenge: ${parsed.reason}. Nothing was proposed.`);
        const ch = parsed.challenge;
        const expectedNetwork = ch.version === 2 ? BASE_CHAIN : "base";
        const problems: string[] = [];
        if (ch.scheme !== "exact") problems.push(`scheme is ${ch.scheme}, expected exact`);
        if (ch.network !== expectedNetwork) problems.push(`network is ${ch.network}, expected ${expectedNetwork}`);
        if (ch.asset.toLowerCase() !== BASE_USDC.toLowerCase()) problems.push(`asset is ${ch.asset}, expected Base USDC ${BASE_USDC}`);
        if (ch.payTo.toLowerCase() !== quote.pay_to.toLowerCase()) problems.push(`payTo ${ch.payTo} differs from the quote's pay_to ${quote.pay_to}`);
        if (ch.amount !== quote.amount) problems.push(`amount ${ch.amount} differs from the quote's ${quote.amount}`);
        if (problems.length) return fail(`Refusing to propose: ${problems.join("; ")}. Nothing was proposed.`);

        const payee = getAddress(quote.pay_to);
        const result = proposeX402({ chain: BASE_CHAIN, url, method: "POST", maxAmount: quote.amount });
        const resourceNote = ch.resourceUrl && ch.resourceUrl !== url ? ` Note: the challenge names resource ${ch.resourceUrl}.` : "";
        result.content = [{
          type: "text",
          text:
            `Unsigned x402 payment proposal: ${usdc(quote.amount)} USDC (${quote.amount} atomic units) on Base (eip155:8453) ` +
            `to payee ${payee} for Keyframe spike quote ${quote_id}, sent as POST ${url}. ` +
            `Checked the live 402 (x402 v${ch.version}, PAYMENT-REQUIRED sha256 ${ch.sha256}): one exact USDC challenge whose payee and amount equal the quote.${resourceNote} ` +
            `The payee in the PayBox window must be ${payee}; it is a codeless test address controlled by the Keyframe builder (HD index ${quote.pay_to_index ?? "?"}) and is swept back after the test. ` +
            `Nothing is signed or paid until you approve in PayBox. After approval, poll get_request with the returned request id; do not run this tool again.`,
        }];
        return result;
      } catch (error) {
        if (error instanceof ToolFailure) return fail(error.message);
        return fail(error instanceof Error ? `Could not prepare the proposal: ${error.message}` : "Could not prepare the proposal.");
      }
    },
  );

  server.registerTool(
    "keyframe_commission_direct",
    {
      title: "Keyframe spike: pay a test quote by direct USDC transfer",
      description:
        "Direct-rail fallback (for EIP-7702-delegated wallets or when x402 is refused). Input: quote_id. Fetches the quote and returns one unsigned Base transaction calling USDC.transfer(pay_to, amount). " +
        "The wallet pays gas in ETH. Pass wallet_id in use_plugin when several wallets are granted, then poll get_request; never call this tool again to poll.",
      inputSchema: input,
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id }) => {
      try {
        const budget = new Budget(8_500);
        const { base } = resolveApiBase();
        const quote = await loadQuote(base, quote_id, budget);
        const payee = getAddress(quote.pay_to);
        const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payee, BigInt(quote.amount)] });
        const result = proposeEvm({ chain: BASE_CHAIN, to: BASE_USDC, value: "0", data });
        result.content = [{
          type: "text",
          text:
            `Unsigned Base transaction: call USDC ${BASE_USDC} transfer(${payee}, ${quote.amount}) = ${usdc(quote.amount)} USDC for Keyframe spike quote ${quote_id}. ` +
            `Native value 0; the wallet pays gas in ETH. PayBox shows raw calldata only: selector 0xa9059cbb, then the recipient ${payee} and the amount ${quote.amount} (atomic units). ` +
            `Nothing is signed until you approve in PayBox; then poll get_request with the returned request id.`,
        }];
        return result;
      } catch (error) {
        if (error instanceof ToolFailure) return fail(error.message);
        return fail(error instanceof Error ? `Could not prepare the proposal: ${error.message}` : "Could not prepare the proposal.");
      }
    },
  );
}
