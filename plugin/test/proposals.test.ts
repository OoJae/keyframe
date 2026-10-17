// Proposal envelopes (verification.md P7): exactly the starter's strict schemas, x402 maxAmount == T.amount,
// expiresAt whole-second Z and <= min(now + 240 s, quote expiry - 60 s), evm value "0" with the exact calldata.

import { Ajv2020 } from "ajv/dist/2020.js";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { chunkAddr } from "../src/core/text.js";
import { evmOutputSchema, x402OutputSchema } from "../src/paybox.js";
import { erc20Abi, keyframeFactoryAbi, USDC } from "../src/protocol/index.js";
import { commissionDirectTool, commissionTool } from "../src/tools/commission.js";
import { quoteTool } from "../src/tools/quote.js";
import { refundTool } from "../src/tools/refund.js";
import { call, type Json, PROPOSAL, setup, stingInput } from "./harness/inproc.js";
import { BUYER, FACTORY, HOSTS } from "./harness/world.js";

const jsonSchemaOf = (s: { "~standard": unknown }) =>
  (s as unknown as { "~standard": { jsonSchema: { output: (o: object) => object } } })["~standard"].jsonSchema.output({
    target: "draft-2020-12",
  });
const ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false });
const validX402 = ajv.compile(jsonSchemaOf(x402OutputSchema));
const validEvm = ajv.compile(jsonSchemaOf(evmOutputSchema));

async function freshQuote(world: ReturnType<typeof setup>) {
  return world.createQuote(quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>);
}

const pay = (rec: { quote: Record<string, unknown>; termsHash: string }) => ({
  quote_id: rec.quote.quote_id,
  buyer: BUYER.address,
  terms_hash: rec.termsHash,
});

describe("keyframe_commission (x402)", () => {
  it("returns only the starter x402 proposal: POST to the order URL, maxAmount = T.amount, <= 240 s", async () => {
    const world = setup();
    const rec = await freshQuote(world);
    const before = Math.floor(Date.now() / 1000);
    const r = await call(commissionTool, pay(rec));
    expect(r.isError).toBeUndefined();
    expect(Object.keys(r.structuredContent ?? {})).toEqual([PROPOSAL]);
    x402OutputSchema.parse(r.structuredContent);
    expect(validX402(r.structuredContent)).toBe(true);
    const p = (r.structuredContent as Record<string, Json>)[PROPOSAL];
    expect(p).toMatchObject({
      version: "1",
      kind: "x402",
      chain: "eip155:8453",
      request: { url: `${HOSTS.api}/v1/orders/${rec.quote.quote_id}`, method: "POST" },
      payment: { asset: USDC.toLowerCase(), maxAmount: rec.terms.amount.toString() },
    });
    expect(p.request.body).toBeUndefined();
    expect(p.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const exp = Date.parse(p.expiresAt) / 1000;
    expect(exp).toBeGreaterThan(before);
    expect(exp).toBeLessThanOrEqual(before + 240 + 1);
    expect(exp).toBeLessThanOrEqual((rec.quote.quote_expires_at as number) - 60);
    expect(r.text).toContain(`must show payee ${chunkAddr(rec.escrow)}`);
    expect(r.text).toContain("never call keyframe_commission twice");
    expect(r.text).not.toMatch(/PayBox-verified/i);
  });

  it("caps expiresAt at quote expiry - 60 s", async () => {
    const world = setup();
    const rec = await freshQuote(world);
    rec.quote.quote_expires_at = Math.floor(Date.now() / 1000) + 150;
    const r = await call(commissionTool, pay(rec));
    const p = (r.structuredContent as Record<string, Json>)[PROPOSAL];
    expect(Date.parse(p.expiresAt) / 1000).toBe((rec.quote.quote_expires_at as number) - 60);
  });

  it("accepts the x402 v1 wire (X402_WIRE=v1 fallback)", async () => {
    const world = setup();
    world.wire = "v1";
    const rec = await freshQuote(world);
    const r = await call(commissionTool, pay(rec));
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("x402 v1");
  });
});

describe("keyframe_commission_direct (evm)", () => {
  it("returns only the starter evm proposal: USDC.transfer(E, amount), value 0", async () => {
    const world = setup();
    const rec = await freshQuote(world);
    const r = await call(commissionDirectTool, pay(rec));
    expect(r.isError).toBeUndefined();
    expect(Object.keys(r.structuredContent ?? {})).toEqual([PROPOSAL]);
    expect(validEvm(r.structuredContent)).toBe(true);
    const p = (r.structuredContent as Record<string, Json>)[PROPOSAL];
    expect(p.transaction.to).toBe(USDC);
    expect(p.transaction.value).toBe("0");
    expect(p.transaction.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [rec.escrow, rec.terms.amount] }),
    );
    expect(r.text).toContain(p.transaction.data);
  });

  it("warns (without refusing) when the wallet has too little ETH for gas", async () => {
    const world = setup();
    world.setWallet(BUYER.address, { eth: 0n });
    const rec = await freshQuote(world);
    const r = await call(commissionDirectTool, pay(rec));
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/WARNING: the buyer wallet has only 0 ETH/);
  });
});

describe("keyframe_refund (evm)", () => {
  it("proposes factory.refund(T) after the deadline, to the allowlisted factory, value 0", async () => {
    const world = setup();
    world.deadlineAt = Math.floor(Date.now() / 1000) - 120;
    const rec = await freshQuote(world);
    world.pay(rec.quote.quote_id as string);
    const r = await call(refundTool, { action: "refund", terms: rec.quote.terms, factory: FACTORY });
    expect(r.isError, r.text).toBeUndefined();
    expect(validEvm(r.structuredContent)).toBe(true);
    const p = (r.structuredContent as Record<string, Json>)[PROPOSAL];
    expect(p.transaction.to).toBe(FACTORY);
    expect(p.transaction.value).toBe("0");
    const decoded = decodeFunctionData({ abi: keyframeFactoryAbi, data: p.transaction.data });
    expect(decoded.functionName).toBe("refund");
    expect((decoded.args[0] as { buyer: string }).buyer).toBe(BUYER.address);
    expect(r.text).toMatch(/can only send these funds to the deal's buyer/);
  });
});
