import { CAIP2, MAX_AMOUNT, USDC } from "@keyframe/protocol";
import { CATALOG, formatUsdc } from "./catalog.js";
import type { Config } from "./config.js";

// Discovery documents for any agent or x402 client (not only the PayBox plugin).

export function llmsTxt(cfg: Config): string {
  const formats = CATALOG.filter((i) => !i.hidden)
    .map((i) => {
      const prices = Object.entries(i.prices)
        .map(([d, p]) => `${d}s ${formatUsdc(p)} USDC`)
        .join(", ");
      const off = cfg.formatsDisabled.has(i.id) ? " (not available yet)" : "";
      return `- ${i.id} (${i.tier}): ${i.title}. ${prices}.${off}`;
    })
    .join("\n");
  return `# Keyframe

> Hire a motion designer from chat and pay only on delivery. Every order is a pay-on-delivery escrow on Base:
> the buyer's USDC goes to an address derived from the deal (CREATE2 of the order terms), which can pay the
> studio only when the key to the buyer's file is published on-chain before the deadline; otherwise it can only
> return to the buyer.

## Flow (x402, any client)
1. GET ${cfg.publicBaseUrl}/v1/styles: formats, styles and prices.
2. POST ${cfg.publicBaseUrl}/v1/quotes with {buyer, format, params, rights_confirmed: true}. Instant quotes start
   as "draft" while the key frame and encrypted file render; poll GET /v1/quotes/{quote_id} until "final".
   503 studio_offline: the render studio is offline, so no Instant quote was made and nothing was charged;
   retry after Retry-After. Studio (hand-made) commissions stay open.
3. Any method on ${cfg.publicBaseUrl}/v1/orders/{quote_id} answers HTTP 402 (x402 ${cfg.wire}, scheme exact,
   network ${CAIP2}, asset USDC ${USDC}, payTo = the order's escrow, amount = the quoted price). Pay it with an
   EIP-3009 authorization from the quoted buyer wallet. The 200 response carries order_id and access_token.
4. GET ${cfg.publicBaseUrl}/v1/orders/{order_id}?token=… for progress. The key is published on Base in
   factory.release; verify everything from chain + public storage (manifest hash, chunk hashes, AES-256-GCM).

Refusals before settlement (409 wrong payer or already paid, 410 expired, 425 still rendering, 451 sanctioned,
503 at capacity) never charge and say "charged": false. If a settlement already started and its outcome is not
known yet the answer is 409 settlement_in_progress with "charged": "unknown": retry the SAME request (same payment
header) or poll GET /v1/quotes/{quote_id}; never sign a second payment. Draft quotes are not payable (payable:
false): their escrow and terms are provisional. The paid body's access_token and k_buyer are returned only right
after settlement; recover them later with SIWE (/v1/auth/siwe/challenge, /verify). Send the access_token as
"Authorization: Bearer …" (or ?token=). Costly endpoints are rate limited per client (429 + Retry-After).

Studio: after a "changes" request payment is never released on silence. One revision may be delivered; the
studio is paid only on your explicit accept, and without one you are refunded after the review end plus grace.

## Formats
${formats}

## Limits
- Max order: ${formatUsdc(cfg.maxAmount < MAX_AMOUNT ? cfg.maxAmount : MAX_AMOUNT)} USDC. Contracts are unaudited.
- Escrow factory: ${cfg.factory} (Base mainnet, chain id 8453).
- OpenAPI: ${cfg.publicBaseUrl}/openapi.json
`;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const ok = (description: string, schema: unknown = { type: "object" }) => ({
  description,
  content: { "application/json": { schema } },
});
const err = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });

export function openApi(cfg: Config) {
  const qid = {
    name: "quote_id",
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^q_[1-9A-HJ-NP-Za-km-z]{22}$" },
  };
  const oid = {
    name: "order_id",
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^o_[1-9A-HJ-NP-Za-km-z]{22}$" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Keyframe API",
      version: "1.0.0",
      description: "Pay-on-delivery motion design over x402 on Base. Responses may add fields, never remove or rename.",
    },
    servers: [{ url: cfg.publicBaseUrl }],
    paths: {
      "/v1/styles": {
        get: {
          summary: "Catalog: formats, styles, prices",
          parameters: [
            { name: "tier", in: "query", schema: { type: "string", enum: ["instant", "studio"] } },
            { name: "format", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": ok("Catalog") },
        },
      },
      "/v1/quotes": {
        post: {
          summary: "Create a quote (Instant: draft until rendered; Studio: final)",
          requestBody: jsonBody(ref("QuoteRequest")),
          responses: {
            "201": ok("Quote", ref("Quote")),
            "400": err("Invalid request"),
            "422": err("Content policy"),
            "429": err("Rate limited"),
            "451": err("Sanctioned buyer"),
            "503": err("Unavailable (studio_offline: the render studio is offline, Instant only; nothing charged)"),
          },
        },
      },
      "/v1/quotes/{quote_id}": {
        get: {
          summary: "Quote",
          parameters: [qid],
          responses: { "200": ok("Quote", ref("Quote")), "404": err("Unknown") },
        },
      },
      "/v1/orders/{quote_id}": {
        post: {
          summary: "x402 resource: pay into the order's escrow (any HTTP method behaves the same)",
          parameters: [
            qid,
            { name: "PAYMENT-SIGNATURE", in: "header", schema: { type: "string" }, description: "x402 v2 payment" },
            { name: "X-PAYMENT", in: "header", schema: { type: "string" }, description: "x402 v1 payment" },
          ],
          responses: {
            "200": ok(
              "Paid (a later replay of the same header has access_token/k_buyer null: use SIWE)",
              ref("PaidResponse"),
            ),
            "402": { description: "Payment required (x402 PAYMENT-REQUIRED header, body {})" },
            "409": err(
              'Already paid / payer mismatch (charged: false), or settlement_in_progress (charged: "unknown": retry the same request)',
            ),
            "410": err("Expired or cancelled (not charged)"),
            "425": err("Quote still rendering (not charged)"),
            "429": err("Rate limited (not processed; retry the same request after Retry-After)"),
            "451": err("Sanctioned payer (not charged)"),
            "503": err("At capacity or unavailable (not charged), or settlement_recording_delayed (charged: true)"),
          },
        },
      },
      "/v1/orders/{order_id}": {
        get: {
          summary: "Order status (access_token as Authorization: Bearer, or ?token=, for owner detail)",
          parameters: [
            oid,
            { name: "token", in: "query", schema: { type: "string" } },
            { name: "Authorization", in: "header", schema: { type: "string" }, description: "Bearer <access_token>" },
          ],
          responses: { "200": ok("Order"), "401": err("Bad token"), "404": err("Unknown") },
        },
      },
      "/v1/orders": {
        get: {
          summary: "Public order list for a buyer (ids + statuses)",
          parameters: [{ name: "buyer", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Orders") },
        },
      },
      "/v1/auth/siwe/challenge": {
        post: {
          summary: "EIP-4361 challenge",
          requestBody: jsonBody({ type: "object", required: ["address"], properties: { address: { type: "string" } } }),
          responses: { "200": ok("{message}") },
        },
      },
      "/v1/auth/siwe/verify": {
        post: {
          summary: "Verify SIWE; returns orders with access_token and k_buyer",
          requestBody: jsonBody({
            type: "object",
            required: ["address", "message", "signature"],
            properties: { address: { type: "string" }, message: { type: "string" }, signature: { type: "string" } },
          }),
          responses: { "200": ok("{orders}"), "401": err("Invalid") },
        },
      },
      "/v1/reviews/{order_id}/challenge": {
        post: {
          summary: "Studio review: EIP-712 Decision typed data",
          parameters: [oid],
          requestBody: jsonBody({
            type: "object",
            required: ["access_token", "decision"],
            properties: { access_token: { type: "string" }, decision: { enum: ["accept", "reject", "changes"] } },
          }),
          responses: { "200": ok("{typed_data}") },
        },
      },
      "/v1/reviews/{order_id}/submit": {
        post: {
          summary: "Studio review: relay decideBySig",
          parameters: [oid],
          requestBody: jsonBody({
            type: "object",
            required: ["access_token", "decision"],
            properties: {
              access_token: { type: "string" },
              decision: { enum: ["accept", "reject", "changes"] },
              signature: { type: "string" },
              sig_deadline: { type: "integer" },
            },
          }),
          responses: { "200": ok("{tx}") },
        },
      },
      "/v1/stats": { get: { summary: "Live counters", responses: { "200": ok("Stats") } } },
      "/health": { get: { summary: "Health", responses: { "200": ok("Health") } } },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            detail: { type: "string" },
            charged: { oneOf: [{ type: "boolean" }, { const: "unknown" }] },
          },
        },
        QuoteRequest: {
          type: "object",
          required: ["buyer", "format", "params"],
          properties: {
            buyer: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            format: {
              enum: [
                "launch_sting",
                "countdown",
                "portfolio_pulse",
                "kinetic_post",
                "chart_moment",
                "studio",
                "catalog",
              ],
            },
            aspect: { enum: ["9:16", "1:1", "16:9"] },
            deadline_minutes: { type: "integer", minimum: 5, maximum: 1440 },
            delivery: { enum: ["public", "private"] },
            rights_confirmed: { const: true },
            params: { type: "object" },
          },
        },
        Quote: { type: "object", description: "frozen-interfaces.md §7 quote object" },
        PaidResponse: {
          type: "object",
          required: [
            "v",
            "order_id",
            "access_token",
            "quote_id",
            "terms_hash",
            "escrow",
            "amount",
            "deadline",
            "funding_tx",
            "funding",
            "k_buyer",
            "status_url",
            "next",
          ],
        },
      },
    },
  };
}
