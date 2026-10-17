import { describe, expect, it } from "vitest";
import { quoteTool } from "../src/tools/quote.js";
import { statusTool } from "../src/tools/status.js";
import { call, type Json, setup, stingInput } from "./harness/inproc.js";
import { BUYER, type World } from "./harness/world.js";

async function paid(world: World, extra: Record<string, unknown> = {}) {
  const rec = await world.createQuote(
    quoteTool.inputSchema.parse(stingInput(BUYER.address, extra)) as Record<string, unknown>,
  );
  world.pay(rec.quote.quote_id as string);
  return rec;
}

describe("keyframe_status", () => {
  it("needs exactly one of quote_id / order_id", () => {
    expect(statusTool.inputSchema.safeParse({}).success).toBe(false);
    expect(
      statusTool.inputSchema.safeParse({ quote_id: "q_1111111111111111111111", order_id: "o_1111111111111111111111" })
        .success,
    ).toBe(false);
  });

  it("order: SEALED while rendering, with progress and the next poll", async () => {
    const world = setup();
    const rec = await paid(world);
    const r = await call(statusTool, { order_id: rec.orderId });
    const s = r.structuredContent as Record<string, Json>;
    expect(s.envelope).toBe("SEALED");
    expect(s.onchain).toMatchObject({
      status: "Open",
      escrow: rec.escrow,
      escrow_code: "none",
      rpcs_answered: 2,
      consistent: true,
    });
    expect(r.text).toMatch(/Keyframe reports: rendering 60%, about 20 s left/);
    expect(s.next.tool).toBe("keyframe_status");
    expect(s.poll_after_s).toBe(5);
  });

  it("order: KEY PUBLISHED points to keyframe_verify delivery; RETURNED to funding", async () => {
    const world = setup();
    const rec = await paid(world);
    world.release(rec.quote.quote_id as string);
    let s = (await call(statusTool, { order_id: rec.orderId })).structuredContent as Record<string, Json>;
    expect(s.envelope).toBe("KEY PUBLISHED");
    expect(s.onchain.escrow_code).toBe("eip1167");
    expect(s.next).toMatchObject({ tool: "keyframe_verify", input: { mode: "delivery", order_id: rec.orderId } });
    world.setOrder(rec.quote.quote_id as string, { status: 4, toSeller: 0n, toBuyer: rec.terms.amount });
    s = (await call(statusTool, { order_id: rec.orderId })).structuredContent as Record<string, Json>;
    expect(s.envelope).toBe("RETURNED");
    expect(s.next.input.mode).toBe("funding");
  });

  it("private order needs the access_token", async () => {
    const world = setup();
    const rec = await paid(world, { delivery: "private" });
    const r = await call(statusTool, { order_id: rec.orderId });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 401/);
    const ok = await call(statusTool, { order_id: rec.orderId, access_token: rec.accessToken });
    expect(ok.isError).toBeUndefined();
    expect(JSON.stringify(ok)).not.toContain(rec.accessToken);
  });

  it("wait_s waits for a change on Base and returns early when it happens", async () => {
    const world = setup();
    const rec = await paid(world);
    setTimeout(() => world.release(rec.quote.quote_id as string), 1_000);
    const r = await call(statusTool, { order_id: rec.orderId, wait_s: 6 });
    expect((r.structuredContent as Record<string, Json>).envelope).toBe("KEY PUBLISHED");
    expect(r.ms).toBeLessThan(5_000);
  });

  it("past the deadline with funds still sealed: suggests the refund fallback", async () => {
    const world = setup();
    world.deadlineAt = Math.floor(Date.now() / 1000) - 30;
    const rec = await paid(world);
    const s = (await call(statusTool, { order_id: rec.orderId })).structuredContent as Record<string, Json>;
    expect(s.next).toMatchObject({ tool: "keyframe_refund", input: { action: "refund" } });
  });

  it("quote already paid: reports the chain state instead of the quote card", async () => {
    const world = setup();
    const rec = await paid(world);
    const r = await call(statusTool, { quote_id: rec.quote.quote_id });
    const s = r.structuredContent as Record<string, Json>;
    expect(s.kind).toBe("quote");
    expect(s.quote).toBeNull();
    expect(s.envelope).toBe("SEALED");
  });

  it("never leaks the RPC URL (with its path secret) in output", async () => {
    const world = setup();
    const rec = await paid(world);
    world.down.add("rpc2.kf.test");
    const r = await call(statusTool, { order_id: rec.orderId });
    expect(JSON.stringify(r)).not.toMatch(/KF-SECRET-MARKER|rpc2\.kf\.test|rpc1\.kf\.test/);
  });
});
