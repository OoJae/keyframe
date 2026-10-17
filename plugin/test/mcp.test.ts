// End-to-end over MCP stdio: spawns the built dist/plugin.mjs (one process per operation, like the PayBox sandbox
// and the starter conformance runner) against the mock backend/chain/file host served over local HTTP, and calls
// every tool. Each successful result is validated against the tool's declared JSON Schemas with the starter's
// own validator (scripts/schema.mjs).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECISION_TYPES } from "../src/protocol/index.js";
import { quoteTool } from "../src/tools/quote.js";
import type { Json } from "./harness/inproc.js";
import { mcp, serve, starterValidator } from "./harness/mcp.js";
import { BUYER, FACTORY, World } from "./harness/world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(here, "../tool-catalog.json"), "utf8"));
const PROPOSAL = "io.paybox/transactionProposal";

let world: World;
let server: { url: string; close: () => Promise<void> };
let tools: Record<string, Json>[];
let validate: Awaited<ReturnType<typeof starterValidator>>;

beforeAll(async () => {
  world = new World();
  server = await serve(world);
  validate = await starterValidator();
  const list = await mcp("tools/list", {}, { target: server.url });
  tools = list.message.result.tools;
});
afterAll(async () => server?.close());

async function callTool(name: string, args: Record<string, unknown>, env?: Record<string, string>) {
  const op = await mcp("tools/call", { name, arguments: args }, { target: server.url, env });
  expect(op.message.result?.resultType).toBe("complete");
  const result = op.message.result as { content: { text: string }[]; structuredContent?: Json; isError?: boolean };
  if (!result.isError)
    validate(
      tools.find((t) => t.name === name),
      args,
      result,
    );
  expect(op.stdoutBytes).toBeLessThan(64 * 1024);
  expect(op.ms).toBeLessThan(9_500);
  return { ...result, text: result.content.map((c) => c.text).join("\n") };
}

const newQuote = (body: Record<string, unknown>) =>
  world.createQuote(quoteTool.inputSchema.parse(body) as Record<string, unknown>);

describe("dist/plugin.mjs over MCP stdio", () => {
  it("lists exactly the 9 frozen tools, identical to tool-catalog.json", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "keyframe_styles",
      "keyframe_quote",
      "keyframe_commission",
      "keyframe_commission_direct",
      "keyframe_status",
      "keyframe_verify",
      "keyframe_refund",
      "keyframe_review",
      "keyframe_orders",
    ]);
    for (const t of tools) {
      const snap = catalog.tools.find((c: Json) => c.name === t.name);
      expect({ ...t, icons: undefined, execution: undefined, _meta: undefined }).toMatchObject(snap);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("keyframe_styles: live catalog", async () => {
    const r = await callTool("keyframe_styles", {});
    expect(r.structuredContent.source).toBe("live");
    expect(r.structuredContent.formats.map((f: Json) => f.id)).toContain("launch_sting");
  });

  it("keyframe_styles: embedded fallback when the API is unreachable", async () => {
    world.down.add("api.kf.test");
    try {
      const r = await callTool("keyframe_styles", { tier: "studio" });
      expect(r.structuredContent.source).toBe("embedded");
      expect(r.structuredContent.formats.every((f: Json) => f.tier === "studio")).toBe(true);
    } finally {
      world.down.clear();
    }
  });

  let quoteId: string;
  it("keyframe_quote: checked quote card, x402 route", async () => {
    const r = await callTool("keyframe_quote", {
      buyer: BUYER.address,
      format: "launch_sting",
      rights_confirmed: true,
      params: { style: "instrument", wordmark: "Ripcord", tagline: "Agents decide. Ripcord lands the rescue." },
    });
    expect(r.isError).toBeUndefined();
    quoteId = r.structuredContent.quote_id;
    expect(r.structuredContent).toMatchObject({
      payable: true,
      route: { kind: "x402" },
      next: { tool: "keyframe_commission" },
    });
    expect(r.text).toContain(
      "Checks by this plugin: address recomputed ✓ · live payment request pays exactly 4.00 USDC to it ✓ · preview matches the deal ✓",
    );
  });

  it("keyframe_commission: one strict x402 proposal", async () => {
    const r = await callTool("keyframe_commission", { quote_id: quoteId });
    expect(Object.keys(r.structuredContent)).toEqual([PROPOSAL]);
    expect(r.structuredContent[PROPOSAL]).toMatchObject({
      kind: "x402",
      payment: { maxAmount: "4000000" },
      request: { method: "POST" },
    });
  });

  it("keyframe_commission_direct: one strict evm proposal", async () => {
    const r = await callTool("keyframe_commission_direct", { quote_id: quoteId });
    expect(r.structuredContent[PROPOSAL]).toMatchObject({
      kind: "evm",
      chain: "eip155:8453",
      transaction: { value: "0" },
    });
  });

  it("keyframe_commission: refuses a hostile 402 (no proposal) through the real bundle", async () => {
    const rec = await newQuote({
      buyer: BUYER.address,
      format: "launch_sting",
      rights_confirmed: true,
      params: { style: "a", wordmark: "W" },
    });
    rec.payTo = "0x000000000000000000000000000000000000dEaD";
    const r = await callTool("keyframe_commission", { quote_id: rec.quote.quote_id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.text).toMatch(/Nothing was proposed/);
  });

  let paid: Record<string, unknown>;
  it("keyframe_status + keyframe_verify funding after payment", async () => {
    const tx = world.pay(quoteId);
    paid = world.paidBody(quoteId, tx);
    const st = await callTool("keyframe_status", { order_id: paid.order_id });
    expect(st.structuredContent.envelope).toBe("SEALED");
    const v = await callTool("keyframe_verify", { mode: "funding", paid_response: { response: { body: paid } } });
    expect(v.structuredContent).toMatchObject({ verdict: "verified", envelope: "SEALED" });
  });

  it("keyframe_verify delivery: downloads, decrypts and checks all chunks over HTTP", async () => {
    world.release(quoteId);
    const v = await callTool("keyframe_verify", { mode: "delivery", paid_response: paid });
    expect(v.structuredContent).toMatchObject({
      verdict: "verified",
      envelope: "KEY PUBLISHED",
      delivery: { chunks_total: 3, chunks_verified: 3, media: { width: 1080, height: 1920, duration_ms: 6000 } },
    });
  });

  it("keyframe_verify derive: the offline conformance sample", async () => {
    const sample = JSON.parse(readFileSync(path.join(here, "../paybox-plugin.json"), "utf8"));
    const v = await callTool(sample.tool, sample.arguments);
    expect(v.structuredContent).toMatchObject({
      mode: "derive",
      verdict: "verified",
      escrow: "0x05ECce9D3B27a58361a04F461B24287CA47Ef546",
    });
  });

  it("keyframe_refund: refund after the deadline", async () => {
    world.deadlineAt = Math.floor(Date.now() / 1000) - 60;
    const rec = await newQuote({
      buyer: BUYER.address,
      format: "countdown",
      rights_confirmed: true,
      params: { style: "a", label: "L", target: "2026-12-01T00:00:00Z" },
    });
    world.deadlineAt = undefined;
    world.pay(rec.quote.quote_id as string);
    const r = await callTool("keyframe_refund", { action: "refund", quote_id: rec.quote.quote_id });
    expect(r.isError, r.text).toBeUndefined();
    expect(r.structuredContent[PROPOSAL].transaction.to).toBe(FACTORY);
  });

  it("keyframe_review: two-stage EIP-712 accept", async () => {
    const rec = await newQuote({
      buyer: BUYER.address,
      format: "studio",
      rights_confirmed: true,
      params: { deliverable: "studio_sting", brief: "A forty-plus character brief for a hand-made studio sting." },
    });
    world.pay(rec.quote.quote_id as string);
    world.deliverStudio(rec.quote.quote_id as string);
    const base = { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" };
    const s1 = await callTool("keyframe_review", base);
    const td = s1.structuredContent.typed_data;
    const signature = await BUYER.signTypedData({
      domain: td.domain,
      types: { Decision: DECISION_TYPES.Decision },
      primaryType: "Decision",
      message: { ...td.message, deadline: BigInt(td.message.deadline) },
    });
    const s2 = await callTool("keyframe_review", {
      ...base,
      signature,
      sig_deadline: s1.structuredContent.sig_deadline,
    });
    expect(s2.structuredContent).toMatchObject({ stage: "submitted", signer: BUYER.address });
  });

  it("keyframe_orders: two-stage SIWE recovery", async () => {
    const s1 = await callTool("keyframe_orders", { address: BUYER.address });
    const message = s1.structuredContent.message as string;
    const s2 = await callTool("keyframe_orders", {
      address: BUYER.address,
      message,
      signature: await BUYER.signMessage({ message }),
    });
    expect(s2.structuredContent.stage).toBe("signed_in");
    expect(s2.structuredContent.orders.length).toBeGreaterThan(0);
  });

  it("runs offline with no KEYFRAME_* env at all (embedded defaults) and fails closed for money tools", async () => {
    const empty = Object.fromEntries(
      [
        "KEYFRAME_API_BASE",
        "KEYFRAME_FACTORIES",
        "KEYFRAME_SELLERS",
        "KEYFRAME_OPERATORS",
        "KEYFRAME_RPC_URLS",
        "KEYFRAME_FILES_BASE",
      ].map((k) => [k, ""]),
    );
    const r = await callTool("keyframe_commission", { quote_id: "q_1111111111111111111111" }, empty);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
});
