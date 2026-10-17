import { describe, expect, it } from "vitest";
import { quoteTool } from "../src/tools/quote.js";
import { statusTool } from "../src/tools/status.js";
import { call, type Json, setup, stingInput } from "./harness/inproc.js";
import { BUYER, STRANGER } from "./harness/world.js";

const DELEGATION = `0xef0100${"ab".repeat(20)}` as const;

describe("keyframe_quote", () => {
  it("returns a checked quote card and a payable structured quote (plain wallet -> x402)", async () => {
    const world = setup();
    const r = await call(quoteTool, stingInput(BUYER.address));
    expect(r.isError).toBeUndefined();
    const q = r.structuredContent as Record<string, Json>;
    const rec = world.must(q.quote_id);
    expect(q.payable).toBe(true);
    expect(q.escrow.address).toBe(rec.escrow);
    expect(q.terms_hash).toBe(rec.termsHash);
    expect(q.route.kind).toBe("x402");
    expect(q.next).toMatchObject({ tool: "keyframe_commission", input: { quote_id: q.quote_id } });
    expect(q.checks.filter((c: Json) => c.status === "fail")).toEqual([]);
    for (const id of [
      "escrow_address",
      "terms_hash",
      "live_402",
      "preview_matches_deal",
      "spec_hash",
      "salt",
      "seller_allowlisted",
      "operator_allowlisted",
      "factory_allowlisted",
      "escrow_unused",
      "file_committed",
      "file_available",
    ]) {
      expect(q.checks.find((c: Json) => c.id === id)?.status, id).toBe("pass");
    }
    // Quote card template (§A5)
    expect(r.text).toContain(`Keyframe quote ${q.quote_id}: Launch Sting · instrument style · 9:16 · 6 s`);
    expect(r.text).toContain("Price 4.00 USDC on Base");
    expect(r.text).toContain(
      `Sealed envelope: ${rec.escrow.slice(0, 6)}…${rec.escrow.slice(-4)} (full: ${rec.escrow}). Nothing is deployed there yet.`,
    );
    expect(r.text).toContain(
      "Checks by this plugin: address recomputed ✓ · live payment request pays exactly 4.00 USDC to it ✓ · preview matches the deal ✓",
    );
    expect(r.text).toContain("route: x402 (one approval, no gas)");
    expect(r.text).toContain(`Next: keyframe_commission {quote_id:"${q.quote_id}"}`);
    expect(r.text).not.toMatch(/PayBox-verified|audited|AI video generator/i);
  });

  it("sends the validated input (with defaults) as the POST /v1/quotes body", async () => {
    const world = setup();
    let seen: Record<string, unknown> | undefined;
    world.hooks.quote = (_q, rec) => {
      seen = rec.quote;
    };
    await call(quoteTool, stingInput(BUYER.address.toLowerCase()));
    expect(seen).toBeDefined();
    expect(world.log.some((l) => l.method === "POST" && l.url.endsWith("/v1/quotes"))).toBe(true);
  });

  it("routes a 7702-delegated wallet with ETH to the direct rail (direct-first)", async () => {
    const world = setup();
    world.setWallet(BUYER.address, { code: DELEGATION, eth: 10n ** 15n });
    const r = await call(quoteTool, stingInput(BUYER.address));
    const q = r.structuredContent as Record<string, Json>;
    expect(q.route.kind).toBe("direct");
    expect(q.route.wallet).toMatchObject({ kind: "delegated", delegate: expect.stringMatching(/^0x[aA][bB]/) });
    expect(q.next.tool).toBe("keyframe_commission_direct");
    expect(r.text).toContain("smart-account mode (EIP-7702)");
  });

  it("routes a delegated wallet without ETH to x402 with the auto-undelegate note", async () => {
    const world = setup();
    world.setWallet(BUYER.address, { code: DELEGATION, eth: 0n });
    const q = (await call(quoteTool, stingInput(BUYER.address))).structuredContent as Record<string, Json>;
    expect(q.route.kind).toBe("x402");
    expect(q.route.reason).toMatch(/auto-undelegate/);
  });

  it("KEYFRAME_7702_POLICY=x402-autoundelegate keeps delegated wallets on x402", async () => {
    const world = setup({ KEYFRAME_7702_POLICY: "x402-autoundelegate" });
    world.setWallet(BUYER.address, { code: DELEGATION, eth: 10n ** 15n });
    const q = (await call(quoteTool, stingInput(BUYER.address))).structuredContent as Record<string, Json>;
    expect(q.route.kind).toBe("x402");
  });

  it("names core get_buy_link with the exact shortfall when USDC is short", async () => {
    const world = setup();
    world.setWallet(BUYER.address, { usdc: 1_200_000n });
    const r = await call(quoteTool, stingInput(BUYER.address));
    const q = r.structuredContent as Record<string, Json>;
    expect(q.route.kind).toBe("fund_first");
    expect(q.route.wallet.shortfall_atomic).toBe("2800000");
    expect(q.next.tool).toBe("get_buy_link");
    expect(q.route.reason).toContain("Add at least 2.80 USDC");
  });

  it("KEYFRAME_PRIMARY_RAIL=direct routes plain wallets to the direct rail", async () => {
    setup({ KEYFRAME_PRIMARY_RAIL: "direct" });
    const q = (await call(quoteTool, stingInput(BUYER.address))).structuredContent as Record<string, Json>;
    expect(q.route.kind).toBe("direct");
  });

  it("returns a draft quote as preview pending, then keyframe_status finalizes it", async () => {
    const world = setup();
    world.draftFirst = 1;
    const r = await call(quoteTool, stingInput(BUYER.address));
    const q = r.structuredContent as Record<string, Json>;
    expect(q.quote_status).toBe("draft");
    expect(q.payable).toBe(false);
    expect(q.next).toMatchObject({ tool: "keyframe_status", input: { quote_id: q.quote_id } });
    expect(r.text).toContain("not payable yet");
    const s = await call(statusTool, { quote_id: q.quote_id });
    const sq = s.structuredContent as Record<string, Json>;
    expect(sq.kind).toBe("quote");
    expect(sq.quote.quote_status).toBe("final");
    expect(sq.quote.payable).toBe(true);
    expect(sq.envelope).toBe("NOT SEALED");
  });

  it("rejects a buyer the backend swapped (refunds would go elsewhere)", async () => {
    const world = setup();
    world.hooks.quote = (q) => {
      q.buyer = STRANGER.address;
    };
    const r = await call(quoteTool, stingInput(BUYER.address));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/buyer_matches/);
  });

  it("Studio commission: hand-made tier with a review window, no file bound yet", async () => {
    setup();
    const r = await call(quoteTool, {
      buyer: BUYER.address,
      format: "studio",
      rights_confirmed: true,
      params: {
        deliverable: "studio_sting",
        brief: "A bespoke sting for Ripcord: void black, blaze orange, parachute reveal.",
      },
    });
    expect(r.isError, r.text).toBeUndefined();
    const q = r.structuredContent as Record<string, Json>;
    expect(q).toMatchObject({ tier: "studio", payable: true, price: { usdc: "25.00" } });
    expect(q.checks.find((c: Json) => c.id === "content_bound").detail).toMatch(/bound at delivery/);
    expect(r.text).toMatch(/made by hand by Keyframe's designer/);
    expect(r.text).toMatch(/then 24 h to review/);
  });

  it("refuses in maintenance mode", async () => {
    setup({ KEYFRAME_MAINTENANCE: "1" });
    const r = await call(quoteTool, stingInput(BUYER.address));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/paused for maintenance/);
  });

  it("rejects params that do not match the format (schema superRefine)", () => {
    const bad = stingInput(BUYER.address, { format: "countdown" });
    expect(quoteTool.inputSchema.safeParse(bad).success).toBe(false);
    const extra = stingInput(BUYER.address, { params: { style: "x", wordmark: "y", prompt: "anything" } });
    expect(quoteTool.inputSchema.safeParse(extra).success).toBe(false);
    expect(quoteTool.inputSchema.safeParse({ ...stingInput(BUYER.address), rights_confirmed: false }).success).toBe(
      false,
    );
  });
});
