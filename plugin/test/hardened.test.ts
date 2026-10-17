// The API's hardened semantics (ADR-019) as the plugin must handle them: paid responses that are not a full paid
// body (charged "unknown", settlement_recording_delayed, late replays without secrets, refusals, 429), Studio review
// after a change request (accept until changes.accept_by, also after the on-chain window), and 429 rate limits.

import { describe, expect, it } from "vitest";
import { commissionTool } from "../src/tools/commission.js";
import { ordersTool } from "../src/tools/orders.js";
import { quoteTool } from "../src/tools/quote.js";
import { reviewTool } from "../src/tools/review.js";
import { statusTool } from "../src/tools/status.js";
import { verifyTool } from "../src/tools/verify.js";
import { call, type Json, PROPOSAL, setup, stingInput } from "./harness/inproc.js";
import { BUYER, type QuoteRecord, type World } from "./harness/world.js";

const nowS = () => Math.floor(Date.now() / 1000);
const GRACE = 3 * 86_400;
const byId = (s: Json, id: string) => s.checks.find((c: Json) => c.id === id);

async function quoteRec(world: World, extra: Record<string, unknown> = {}) {
  return world.createQuote(quoteTool.inputSchema.parse(stingInput(BUYER.address, extra)) as Record<string, unknown>);
}

/** Wrap a body the way PayBox's get_request reports a finished x402 request. */
const viaGetRequest = (status: number, body: unknown) => ({
  status: "failed",
  response: { status, body: JSON.stringify(body) },
});

describe("paid responses that are not a full paid body", () => {
  it('charged "unknown" (409 settlement_in_progress): never "failed", never "pay again"; poll keyframe_status', async () => {
    const world = setup();
    const rec = await quoteRec(world);
    const qid = rec.quote.quote_id as string;
    const body = {
      error: "settlement_in_progress",
      detail: "this authorization is being settled and the outcome is not known yet",
      poll: `/v1/quotes/${qid}`,
      retry_after_s: 5,
      charged: "unknown",
    };
    const r = await call(verifyTool, { mode: "funding", paid_response: viaGetRequest(409, body) });
    expect(r.isError, r.text).toBeUndefined();
    const s = r.structuredContent as Json;
    expect(s.verdict).toBe("partial");
    expect(byId(s, "funded").status).toBe("skip");
    expect(s.next).toMatchObject({ tool: "keyframe_status", input: { quote_id: qid } });
    expect(r.text).toMatch(/Do not pay again/);
    // Once the money is at the escrow, the same response verifies the funding.
    world.pay(qid);
    const after = (await call(verifyTool, { mode: "funding", paid_response: body })).structuredContent as Json;
    expect(byId(after, "funded").status).toBe("pass");
  });

  it("503 settlement_recording_delayed (charged true, order not recorded yet) resolves through the quote", async () => {
    const world = setup();
    const rec = await quoteRec(world);
    const qid = rec.quote.quote_id as string;
    const tx = world.pay(qid);
    const body = {
      error: "settlement_recording_delayed",
      message: "Payment settled; order recording delayed. Retry the same request shortly; do not pay again.",
      charged: true,
      quote_id: qid,
      order_id: rec.orderId,
      funding_tx: tx,
    };
    world.byOrder.delete(rec.orderId); // the order is not recorded yet: GET /v1/orders/{o} is 404
    const r = await call(verifyTool, { mode: "funding", paid_response: viaGetRequest(503, body) });
    expect(r.isError, r.text).toBeUndefined();
    const s = r.structuredContent as Json;
    expect(s.verdict).toBe("verified");
    expect(byId(s, "funding_tx").status).toBe("pass");
    expect(r.text).toMatch(/still being recorded\. Do not pay again/);
  });

  it("a late replay (access_token and k_buyer null, secrets_withheld) is parsed and routed to keyframe_orders", async () => {
    const world = setup();
    const rec = await quoteRec(world, { delivery: "private" });
    const qid = rec.quote.quote_id as string;
    const tx = world.pay(qid);
    const late = {
      ...world.paidBody(qid, tx),
      access_token: null,
      k_buyer: null,
      secrets_withheld: true,
      recover: { tool: "keyframe_orders", challenge: "https://api.kf.test/v1/auth/siwe/challenge" },
      note: "This payment was settled earlier; sign in with the buyer wallet (keyframe_orders, SIWE) to recover them.",
    };
    const f = await call(verifyTool, { mode: "funding", paid_response: { response: { status: 200, body: late } } });
    expect(f.isError, f.text).toBeUndefined();
    expect(f.text).toMatch(/secrets_withheld/);
    expect(f.text).toMatch(/keyframe_orders/);
    world.release(qid);
    const d = await call(verifyTool, { mode: "delivery", paid_response: late, quote_id: qid });
    expect(d.isError, d.text).toBeUndefined();
    expect(byId(d.structuredContent, "k_buyer").detail).toMatch(/withholds k_buyer.*keyframe_orders/);
    // With the k_buyer recovered through keyframe_orders, the same late replay verifies the file.
    const ok = await call(verifyTool, { mode: "delivery", paid_response: late, quote_id: qid, k_buyer: rec.kBuyer });
    expect((ok.structuredContent as Json).verdict, ok.text).toBe("verified");
  });

  it("a refusal before settlement (charged false) says no money moved, and never suggests paying", async () => {
    setup();
    const r = await call(verifyTool, {
      mode: "funding",
      paid_response: viaGetRequest(409, { error: "payer_mismatch", charged: false }),
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/charged: false, "payer_mismatch"\): no money moved/);
    expect(r.text).not.toMatch(/pay again|new payment now/i);
  });

  it("a rate-limited payment request (429, processed false) is not a payment and not a failure", async () => {
    setup();
    const r = await call(verifyTool, {
      mode: "funding",
      paid_response: viaGetRequest(429, { error: "rate_limited", processed: false }),
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rate-limited that payment request \(HTTP 429\): it was not processed/);
    expect(r.text).toMatch(/Do not sign a new payment/);
  });
});

describe("a quote whose payment is settling is never paid again", () => {
  it('quote "final" with payable false: commission refuses; status says poll, not "new quote"', async () => {
    const world = setup();
    const rec = await quoteRec(world);
    rec.quote.payable = false;
    const r = await call(commissionTool, {
      quote_id: rec.quote.quote_id,
      buyer: BUYER.address,
      terms_hash: rec.termsHash,
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(PROPOSAL);
    expect(r.text).toMatch(/already being settled.*do not pay again/);
    const s = await call(statusTool, { quote_id: rec.quote.quote_id, buyer: BUYER.address });
    expect((s.structuredContent as Json).next).toMatchObject({ tool: "keyframe_status" });
    expect(s.text).toMatch(/Do not pay again/);
  });

  it('the live payment request answering charged "unknown" blocks the proposal the same way', async () => {
    const world = setup();
    const rec = await quoteRec(world);
    world.hooks.payment = (wire) => {
      wire.status = 409;
      wire.body = JSON.stringify({ error: "settlement_in_progress", charged: "unknown" });
      wire.headers = { "content-type": "application/json" };
    };
    const r = await call(commissionTool, {
      quote_id: rec.quote.quote_id,
      buyer: BUYER.address,
      terms_hash: rec.termsHash,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/live_402.*being settled right now.*do not pay again/);
  });
});

describe("429 rate limits: retry later, never a payment suggestion", () => {
  const limited = (world: World, path: RegExp, retry = "7") => {
    const orig = world.handle.bind(world);
    world.handle = async (req) =>
      path.test(new URL(req.url).pathname)
        ? new Response(JSON.stringify({ error: "rate_limited", detail: "too many requests", processed: false }), {
            status: 429,
            headers: { "content-type": "application/json", "Retry-After": retry },
          })
        : orig(req);
  };

  it("keyframe_quote", async () => {
    const world = setup();
    limited(world, /^\/v1\/quotes$/);
    const r = await call(quoteTool, stingInput(BUYER.address));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rate-limited this request \(HTTP 429\), so it was not processed; retry it after 7 s/);
    expect(r.text).not.toMatch(/commission|pay /i);
  });

  it("keyframe_orders (SIWE) and keyframe_review", async () => {
    const world = setup();
    limited(world, /^\/v1\/(auth\/siwe|reviews)\//, "12");
    const o = await call(ordersTool, { address: BUYER.address });
    expect(o.text).toMatch(/HTTP 429.*retry it after 12 s/);
    const rec = await studio(world);
    const r = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 429.*retry it after 12 s/);
  });

  it("the live payment-request check", async () => {
    const world = setup();
    limited(world, /^\/v1\/orders\/q_/, "9");
    const r = await call(quoteTool, stingInput(BUYER.address));
    expect(r.text).toMatch(/live_402.*HTTP 429.*retry it after 9 s/);
  });
});

async function studio(world: World, deliveredAt?: number): Promise<QuoteRecord> {
  const rec = await world.createQuote(
    quoteTool.inputSchema.parse({
      buyer: BUYER.address,
      format: "studio",
      rights_confirmed: true,
      params: { deliverable: "studio_sting", brief: "A forty-plus character brief for a hand-made studio sting." },
    }) as Record<string, unknown>,
  );
  world.pay(rec.quote.quote_id as string);
  world.deliverStudio(rec.quote.quote_id as string, deliveredAt === undefined ? {} : { deliveredAt });
  return rec;
}

const signDecision = (td: Json) =>
  BUYER.signTypedData({
    domain: td.domain,
    types: { Decision: td.types.Decision },
    primaryType: "Decision",
    message: { ...td.message, deadline: BigInt(td.message.deadline) },
  });

describe("Studio review after a change request (changes.accept_by)", () => {
  // Review window (24 h in the World) closed 2 h ago.
  const pastWindow = () => nowS() - 86_400 - 7_200;

  it("accept after the on-chain window: allowed until accept_by, Decision built locally and bounded", async () => {
    const world = setup();
    const deliveredAt = pastWindow();
    const rec = await studio(world, deliveredAt);
    const closes = deliveredAt + 86_400;
    const acceptBy = closes + GRACE - 720;
    rec.changes = { requested_at: deliveredAt + 100, accept_by: acceptBy, revision: { delivered_at: 1 }, policy: "P" };
    const base = { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" };
    const s1 = await call(reviewTool, base);
    expect(s1.isError, s1.text).toBeUndefined();
    const out = s1.structuredContent as Json;
    expect(out.typed_data).toMatchObject({ primaryType: "Decision", message: { accept: true } });
    expect(out.sig_deadline).toBeLessThanOrEqual(Math.min(nowS() + 7 * 86_400, acceptBy));
    expect(s1.text).toMatch(/verifies this signed accept itself/);
    expect(s1.text).not.toMatch(/counts as accept/);
    // The API answers an off-chain accept with status "accepted" and no transaction.
    const orig = world.handle.bind(world);
    world.handle = async (req) =>
      new URL(req.url).pathname.endsWith("/submit")
        ? new Response(JSON.stringify({ order_id: rec.orderId, decision: "accept", tx: null, status: "accepted" }), {
            status: 200,
          })
        : orig(req);
    const s2 = await call(reviewTool, {
      ...base,
      signature: await signDecision(out.typed_data),
      sig_deadline: out.sig_deadline,
    });
    expect(s2.isError, s2.text).toBeUndefined();
    expect(s2.text).toMatch(/recorded the buyer's signed accept after the review window/);
  });

  it("reject after the window is the full-refund cancel (no kill fee)", async () => {
    const world = setup();
    const deliveredAt = pastWindow();
    const rec = await studio(world, deliveredAt);
    rec.changes = { requested_at: deliveredAt + 100, accept_by: deliveredAt + 86_400 + GRACE - 720 };
    const r = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "reject" });
    expect(r.isError, r.text).toBeUndefined();
    expect(r.text).toMatch(/voids the order \(cancel\) and the full amount returns/);
    expect(r.text).not.toMatch(/kill fee of/);
  });

  it("refuses after the window with no change request, past accept_by, or for another change request", async () => {
    const world = setup();
    const deliveredAt = pastWindow();
    const rec = await studio(world, deliveredAt);
    const base = { order_id: rec.orderId, access_token: rec.accessToken };
    expect((await call(reviewTool, { ...base, decision: "accept" })).text).toMatch(/with no change request/);
    rec.changes = { requested_at: deliveredAt + 100, accept_by: nowS() - 5 };
    expect((await call(reviewTool, { ...base, decision: "accept" })).text).toMatch(/time to accept .* has passed/);
    rec.changes = { requested_at: deliveredAt + 100, accept_by: nowS() + 3_600 };
    expect((await call(reviewTool, { ...base, decision: "changes" })).text).toMatch(/only accept or reject remain/);
  });

  it("a backend accept_by beyond review end + grace is clamped to it", async () => {
    const world = setup();
    const deliveredAt = nowS() - 86_400 - 3 * 86_400 + 600; // 10 min before review end + grace
    const rec = await studio(world, deliveredAt);
    rec.changes = { requested_at: deliveredAt + 100, accept_by: nowS() + 30 * 86_400 };
    const out = (await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" }))
      .structuredContent as Json;
    expect(out.sig_deadline).toBeLessThanOrEqual(deliveredAt + 86_400 + GRACE);
  });

  it("keyframe_status: the review step follows the order (no 'silence counts as accept' after a change request)", async () => {
    const world = setup();
    const rec = await studio(world);
    const c1 = await call(reviewTool, { order_id: rec.orderId, access_token: rec.accessToken, decision: "changes" });
    const td = (c1.structuredContent as Json).typed_data;
    const sig = await BUYER.signTypedData({
      domain: td.domain,
      types: { ChangeRequest: td.types.ChangeRequest },
      primaryType: "ChangeRequest",
      message: { termsHash: td.message.termsHash, deadline: BigInt(td.message.deadline) },
    });
    const c2 = await call(reviewTool, {
      order_id: rec.orderId,
      access_token: rec.accessToken,
      decision: "changes",
      signature: sig,
      sig_deadline: (c1.structuredContent as Json).sig_deadline,
    });
    expect(c2.text).toMatch(/nothing is released on silence.*possible until/);
    const s = (await call(statusTool, { order_id: rec.orderId, access_token: rec.accessToken }))
      .structuredContent as Json;
    expect(s.next.tool).toBe("keyframe_review");
    expect(s.next.note).toMatch(/A change request was made: nothing is released on silence/);
    expect(s.next.note).not.toMatch(/counts as accept/);
    expect(s.meaning).toMatch(/explicit accept/);
    // Without a change request the same order says silence counts as accept.
    const other = await studio(world);
    const s0 = (await call(statusTool, { order_id: other.orderId, access_token: other.accessToken }))
      .structuredContent as Json;
    expect(s0.next.note).toMatch(/With no change request, doing nothing until then counts as accept/);
  });
});
