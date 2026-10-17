import { keyframeFactoryAbi, Status } from "@keyframe/protocol";
import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { keeperTick } from "../src/keeper.js";
import { Harness } from "./support/harness.js";

// Direct rail (USDC.transfer to E, no x402 request) and the already-registered settlement case (ADR-004).

const fund = (h: Harness, escrow: string, amount: bigint) =>
  h.factory.balances.set(escrow.toLowerCase(), (h.factory.balances.get(escrow.toLowerCase()) ?? 0n) + amount);

describe("direct rail", () => {
  it("a USDC.transfer to E of a live final quote is registered, ordered and released by the keeper", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    fund(h, q.escrow, 999_999n);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.relayer.count("register")).toBe(0); // underfunded: wait
    fund(h, q.escrow, 1n);
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.direct_opened).toBe(1);
    const reg = decodeFunctionData({
      abi: keyframeFactoryAbi,
      data: h.relayer.sends.find((x) => x.kind === "register")?.data as Hex,
    });
    expect(reg.functionName).toBe("register");
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
    const quote = await (await h.request(`/v1/quotes/${q.quote_id}`)).json();
    expect(quote.status).toBe("paid");
    const order = await (await h.request(`/v1/orders/${quote.order_id}`)).json();
    expect(order).toMatchObject({ status: "key_published", funding: "confirmed" });
    // the 402 is gone: the quote is paid
    expect((await h.request(`/v1/orders/${q.quote_id}`)).status).toBe(409);
  });

  it("POST /v1/quotes/{id}/rail checks immediately", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    fund(h, q.escrow, 1_000_000n);
    const res = await h.postJson(`/v1/quotes/${q.quote_id}/rail`, { rail: "direct" });
    const body = await res.json();
    expect(body).toMatchObject({ outcome: "opened", status: "paid" });
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("funds sent to E after the quote expired are returned to the buyer (cancel before the deadline)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.advance(601);
    fund(h, q.escrow, 1_000_000n);
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.direct_returned).toBe(1);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Cancelled);
    expect(h.factory.view(q.terms_hash).toBuyer).toBe(1_000_000n);
  });
});

describe("already registered (ADR-004)", () => {
  it("fundWithAuthorization reverting AlreadyRegistered with T open for this buyer is a successful payment", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    // an earlier submission of the same authorization already opened T
    const first = h.relayer.override;
    h.relayer.override = (req) => {
      if (req.kind !== "fund") return undefined;
      h.factory.apply(req.data); // opens T …
      return { state: "rejected", reason: "AlreadyRegistered()" }; // … but our call reverts
    };
    const res = await h.pay(q.quote_id, headers);
    h.relayer.override = first;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.funding).toBe("confirmed");
    expect(body.funding_tx).toBe(`0x${"0e".repeat(32)}`);
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("AlreadyRegistered while T is not open is a refusal (not charged)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) =>
      req.kind === "fund" ? { state: "rejected", reason: "AlreadyRegistered()" } : undefined;
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(402);
  });
});
