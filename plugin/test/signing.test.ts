// keyframe_review (EIP-712 Decision relay) and keyframe_orders (SIWE). The plugin cannot sign; it must only ever
// hand the agent messages that are safe to sign, and check signatures locally before relaying them.

import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DECISION_TYPES, USDC } from "../src/protocol/index.js";
import { ordersTool } from "../src/tools/orders.js";
import { quoteTool } from "../src/tools/quote.js";
import { reviewTool } from "../src/tools/review.js";
import { call, type Json, setup } from "./harness/inproc.js";
import { BUYER, FACTORY, OTHER_FACTORY, STRANGER, type World } from "./harness/world.js";

async function studioInReview(world: World) {
  const rec = await world.createQuote(
    quoteTool.inputSchema.parse({
      buyer: BUYER.address,
      format: "studio",
      rights_confirmed: true,
      params: { deliverable: "studio_sting", brief: "A forty-plus character brief for a hand-made studio sting." },
    }) as Record<string, unknown>,
  );
  world.pay(rec.quote.quote_id as string);
  world.deliverStudio(rec.quote.quote_id as string);
  return rec;
}

const sign = (td: Record<string, Json>, who = BUYER) =>
  who.signTypedData({
    domain: td.domain,
    types: { Decision: DECISION_TYPES.Decision },
    primaryType: "Decision",
    message: { ...td.message, deadline: BigInt(td.message.deadline) },
  });

describe("keyframe_review", () => {
  it("accept: stage 1 returns the canonical Decision, stage 2 checks the buyer's signature and relays it", async () => {
    const world = setup();
    const rec = await studioInReview(world);
    const base = { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" };
    const s1 = await call(reviewTool, base);
    expect(s1.isError, s1.text).toBeUndefined();
    const out = s1.structuredContent as Record<string, Json>;
    expect(out.stage).toBe("sign");
    expect(out.typed_data).toMatchObject({
      primaryType: "Decision",
      domain: { name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: FACTORY },
      message: { termsHash: rec.termsHash, accept: true },
    });
    expect(s1.text).toMatch(/request_wallet_sign/);

    const bad = await call(reviewTool, {
      ...base,
      signature: await sign(out.typed_data, STRANGER),
      sig_deadline: out.sig_deadline,
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not from the buyer wallet/);

    const s2 = await call(reviewTool, {
      ...base,
      signature: await sign(out.typed_data),
      sig_deadline: out.sig_deadline,
    });
    expect(s2.isError, s2.text).toBeUndefined();
    expect(s2.structuredContent).toMatchObject({
      stage: "submitted",
      signer: BUYER.address,
      tx: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  });

  it("reject states the kill fee; changes passes an off-chain request type", async () => {
    const world = setup();
    const rec = await studioInReview(world);
    const r = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "reject" });
    expect(r.text).toMatch(/kill fee of 5.00 USDC/);
    expect((r.structuredContent as Json).typed_data.message.accept).toBe(false);
    const c = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "changes" });
    expect(c.isError, c.text).toBeUndefined();
    expect((c.structuredContent as Json).typed_data.primaryType).toBe("ChangeRequest");
  });

  const hostile: [string, (td: Record<string, Json>) => Record<string, Json>, RegExp][] = [
    [
      "a USDC permit disguised as a review",
      () => ({
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
        message: { owner: BUYER.address, spender: STRANGER.address, value: "50000000" },
      }),
      /not the Keyframe Escrow domain/,
    ],
    [
      "a Decision that says the opposite",
      (td) => ({ ...td, message: { ...td.message, accept: false } }),
      /it would reject, not accept/,
    ],
    [
      "a Decision for another order",
      (td) => ({ ...td, message: { ...td.message, termsHash: `0x${"aa".repeat(32)}` } }),
      /not about this order/,
    ],
    ["a Decision on another chain", (td) => ({ ...td, domain: { ...td.domain, chainId: 1 } }), /not Base/],
    [
      "a Decision for a non-allowlisted contract",
      (td) => ({ ...td, domain: { ...td.domain, verifyingContract: OTHER_FACTORY } }),
      /allowlisted escrow factory/,
    ],
    [
      "a Decision with an extra field",
      (td) => ({ ...td, types: { Decision: [...td.types.Decision, { name: "to", type: "address" }] } }),
      /non-standard Decision type/,
    ],
    [
      "a Decision valid for a year",
      (td) => ({ ...td, message: { ...td.message, deadline: String(Math.floor(Date.now() / 1000) + 365 * 86_400) } }),
      /deadline/,
    ],
  ];
  it.each(hostile)("refuses %s", async (_n, mutate, expected) => {
    const world = setup();
    const rec = await studioInReview(world);
    world.hooks.typedData = (td) => mutate(td);
    const r = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Refusing to ask you to sign/);
    expect(r.text).toMatch(expected);
  });

  it("refuses orders that are not in review on Base", async () => {
    const world = setup();
    const rec = await studioInReview(world);
    world.setOrder(rec.quote.quote_id as string, { status: 1 });
    const r = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" });
    expect(r.text).toMatch(/not in review on Base \(it is Open\)/);
  });
});

describe("keyframe_orders (SIWE)", () => {
  it("stage 1 returns a checked Keyframe sign-in; stage 2 verifies the signature and returns access links", async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse({
        buyer: BUYER.address,
        format: "launch_sting",
        rights_confirmed: true,
        delivery: "private",
        params: { style: "a", wordmark: "W" },
      }) as Record<string, unknown>,
    );
    world.pay(rec.quote.quote_id as string);
    const s1 = await call(ordersTool, { address: BUYER.address.toLowerCase() });
    expect(s1.isError, s1.text).toBeUndefined();
    const out = s1.structuredContent as Record<string, Json>;
    expect(out.stage).toBe("sign");
    expect(out.orders).toEqual([{ order_id: rec.orderId, status: "paid" }]);
    expect(s1.text).toMatch(/signs in to api\.kf\.test only/);

    const wrong = await call(ordersTool, {
      address: BUYER.address,
      message: out.message,
      signature: await STRANGER.signMessage({ message: out.message }),
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/signature is from/);

    const s2 = await call(ordersTool, {
      address: BUYER.address,
      message: out.message,
      signature: await BUYER.signMessage({ message: out.message }),
    });
    expect(s2.isError, s2.text).toBeUndefined();
    const o = (s2.structuredContent as Record<string, Json>).orders[0];
    expect(o).toMatchObject({ order_id: rec.orderId, access_token: rec.accessToken, k_buyer: rec.kBuyer });
  });

  const tamper: [string, (m: string) => string, RegExp][] = [
    [
      "another site's domain",
      (m) => m.replace("api.kf.test wants", "app.uniswap.org wants"),
      /signs in to app\.uniswap\.org/,
    ],
    ["another address", (m) => m.replace(/0x[0-9a-fA-F]{40}/, getAddress(STRANGER.address)), /wrong address/],
    ["another chain", (m) => m.replace("Chain ID: 8453", "Chain ID: 1"), /not Base/],
    [
      "a long-lived login",
      (m) => m.replace(/Expiration Time: .*/, `Expiration Time: ${new Date(Date.now() + 86_400_000).toISOString()}`),
      /valid too long/,
    ],
    ["extra lines", (m) => `${m}\nResources:\n- https://evil.example`, /unexpected extra lines/],
    ["a foreign URI", (m) => m.replace(/URI: .*/, "URI: https://evil.example/login"), /URI is not Keyframe's API/],
  ];
  it.each(tamper)("refuses a sign-in message with %s", async (_n, edit, expected) => {
    const world = setup();
    world.hooks.siwe = edit;
    const r = await call(ordersTool, { address: BUYER.address });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(expected);
  });

  it("stage 2 refuses an expired message", async () => {
    setup();
    const issued = new Date(Date.now() - 20 * 60_000);
    const message = [
      "api.kf.test wants you to sign in with your Ethereum account:",
      BUYER.address,
      "",
      "URI: https://api.kf.test/v1/auth/siwe/verify",
      "Version: 1",
      "Chain ID: 8453",
      "Nonce: abcdef0123456789",
      `Issued At: ${issued.toISOString()}`,
      `Expiration Time: ${new Date(issued.getTime() + 10 * 60_000).toISOString()}`,
    ].join("\n");
    const r = await call(ordersTool, {
      address: BUYER.address as Address,
      message,
      signature: (await BUYER.signMessage({ message })) as Hex,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expired/);
  });
});
