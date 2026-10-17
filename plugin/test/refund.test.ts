import { decodeFunctionData, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { keyframeFactoryAbi } from "../src/protocol/index.js";
import { quoteTool } from "../src/tools/quote.js";
import { refundTool } from "../src/tools/refund.js";
import { call, type Json, PROPOSAL, setup, stingInput } from "./harness/inproc.js";
import { BUYER, FACTORY, OTHER_FACTORY, type World } from "./harness/world.js";

const nowS = () => Math.floor(Date.now() / 1000);

async function order(world: World, opts: { deadlineAt?: number; studio?: boolean } = {}) {
  world.deadlineAt = opts.deadlineAt;
  const body = opts.studio
    ? {
        buyer: BUYER.address,
        format: "studio",
        rights_confirmed: true,
        params: { deliverable: "studio_sting", brief: "A forty-plus character brief for a hand-made studio sting." },
      }
    : stingInput(BUYER.address);
  const rec = await world.createQuote(quoteTool.inputSchema.parse(body) as Record<string, unknown>);
  world.pay(rec.quote.quote_id as string);
  return rec;
}

const fn = (r: { structuredContent?: Record<string, unknown> }) =>
  decodeFunctionData({ abi: keyframeFactoryAbi, data: (r.structuredContent as Json)[PROPOSAL].transaction.data });

describe("keyframe_refund", () => {
  it("refuses before the deadline and names the exact time", async () => {
    const world = setup();
    const rec = await order(world);
    const r = await call(refundTool, { action: "refund", quote_id: rec.quote.quote_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not refundable yet: .* becomes refundable after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(JSON.stringify(r)).not.toContain(PROPOSAL);
  });

  it("proposes refund(T) after the deadline (terms via quote_id from the API)", async () => {
    const world = setup();
    const rec = await order(world, { deadlineAt: nowS() - 60 });
    const r = await call(refundTool, { action: "refund", quote_id: rec.quote.quote_id });
    expect(r.isError, r.text).toBeUndefined();
    expect(fn(r).functionName).toBe("refund");
    expect((r.structuredContent as Json)[PROPOSAL].transaction.to).toBe(FACTORY);
  });

  it("works for a refund-only factory but never for a non-allowlisted one", async () => {
    const world = setup({
      KEYFRAME_FACTORIES: JSON.stringify([
        { address: FACTORY, vaultImpl: (await import("./harness/world.js")).VAULT, status: "refund-only" },
      ]),
    });
    const rec = await order(world, { deadlineAt: nowS() - 60 });
    expect(
      (await call(refundTool, { action: "refund", terms: rec.quote.terms, factory: FACTORY })).isError,
    ).toBeUndefined();
    const r = await call(refundTool, { action: "refund", terms: rec.quote.terms, factory: OTHER_FACTORY });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not in KEYFRAME_FACTORIES/);
  });

  it("does not refund a closed order but offers sweep for leftovers, and sweeps", async () => {
    const world = setup();
    const rec = await order(world);
    world.release(rec.quote.quote_id as string);
    world.usdc.set(rec.escrow.toLowerCase(), 500_000n);
    const r = await call(refundTool, { action: "refund", quote_id: rec.quote.quote_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already closed \(Released\).*use action "sweep"/);
    const sw = await call(refundTool, { action: "sweep", quote_id: rec.quote.quote_id });
    expect(sw.isError, sw.text).toBeUndefined();
    const d = fn(sw);
    expect(d.functionName).toBe("sweep");
    expect(sw.text).toMatch(/returns what is left at the envelope to the buyer/);
  });

  it("sweep of the deal token before close is refused; ETH sweep is allowed any time", async () => {
    const world = setup();
    const rec = await order(world);
    expect((await call(refundTool, { action: "sweep", quote_id: rec.quote.quote_id })).text).toMatch(
      /only be swept after the order closes/,
    );
    expect(
      (await call(refundTool, { action: "sweep", quote_id: rec.quote.quote_id, token: zeroAddress })).text,
    ).toMatch(/holds none of that asset/);
    world.eth.set(rec.escrow.toLowerCase(), 10n ** 15n);
    const r = await call(refundTool, { action: "sweep", quote_id: rec.quote.quote_id, token: zeroAddress });
    expect(r.isError, r.text).toBeUndefined();
    expect(fn(r).args[1]).toBe(zeroAddress);
  });

  it("reject: only for a Studio delivery in its review window, as decide(T, false)", async () => {
    const world = setup();
    const instant = await order(world);
    expect((await call(refundTool, { action: "reject", quote_id: instant.quote.quote_id })).text).toMatch(
      /Only Studio orders have a review/,
    );
    const studio = await order(world, { studio: true });
    expect((await call(refundTool, { action: "reject", quote_id: studio.quote.quote_id })).text).toMatch(
      /only possible while a Studio delivery is in review/,
    );
    world.deliverStudio(studio.quote.quote_id as string);
    const r = await call(refundTool, { action: "reject", quote_id: studio.quote.quote_id });
    expect(r.isError, r.text).toBeUndefined();
    const d = fn(r);
    expect(d.functionName).toBe("decide");
    expect(d.args[1]).toBe(false);
    expect(r.text).toMatch(/kill fee of 5.00 USDC/);
    world.deliverStudio(studio.quote.quote_id as string, { deliveredAt: nowS() - 90_000 });
    expect((await call(refundTool, { action: "reject", quote_id: studio.quote.quote_id })).text).toMatch(
      /review window closed/,
    );
  });

  it("refuses when Base cannot be read (fail closed)", async () => {
    const world = setup();
    const rec = await order(world, { deadlineAt: nowS() - 60 });
    world.down.add("rpc1.kf.test");
    world.down.add("rpc2.kf.test");
    const r = await call(refundTool, { action: "refund", quote_id: rec.quote.quote_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Could not read the escrow on Base/);
  });

  it("explicit terms win over the API: altered terms point at an empty escrow, so nothing is proposed", async () => {
    const world = setup();
    const rec = await order(world, { deadlineAt: nowS() - 60 });
    const r = await call(refundTool, {
      action: "refund",
      terms: { ...(rec.quote.terms as object), amount: "1000000" },
      factory: FACTORY,
      quote_id: rec.quote.quote_id,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/holds no USDC/);
  });
});
