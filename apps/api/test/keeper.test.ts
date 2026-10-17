import { Status } from "@keyframe/protocol";
import { describe, expect, it } from "vitest";
import { keeperTick } from "../src/keeper.js";
import type { Sanctions } from "../src/sanctions.js";
import { Harness } from "./support/harness.js";

describe("keeper (cron)", () => {
  it("refunds an Instant order that missed its deadline (release kept failing)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) => (req.kind === "release" ? { state: "unavailable", reason: "rpc down" } : undefined);
    const paid = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open);
    h.advance(q.deadline - h.nowS() + 1);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Refunded);
    const st = await (await h.request(`/v1/orders/${paid.order_id}`)).json();
    expect(st.status).toBe("returned");
    expect(st.refund_tx).toMatch(/^0x/);
  });

  it("sends refundExpired(20) when the factory reports refundable escrows", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) =>
      req.kind === "release" || req.kind === "refund" ? { state: "unavailable", reason: "x" } : undefined;
    await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    await h.drain();
    h.advance(q.deadline - h.nowS() + 1);
    const report = await keeperTick(h.s, { waitMs: 0 });
    expect(report.refund_expired_sent).toBe(true);
    expect(h.relayer.count("refund_expired")).toBe(1);
  });

  it("recovers an action slot abandoned before broadcast (worker died mid-release)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) => (req.kind === "release" ? { state: "unavailable", reason: "x" } : undefined);
    const paid = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    await h.drain();
    h.relayer.override = null;
    h.db.raw
      .prepare("UPDATE orders SET pending_kind = 'release', pending_tx = NULL, pending_since = ? WHERE id = ?")
      .run(h.nowS(), paid.order_id);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open); // a fresh slot is respected
    h.advance(301);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("expires unpaid final quotes, cancels stale drafts, re-queues abandoned render leases", async () => {
    const h = new Harness();
    const final = await h.finalQuote();
    const draft = await h.createQuote();
    const claim = await h.internal("/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "worker-1" }),
    });
    expect(claim.status).toBe(200);
    h.advance(601);
    const r1 = await keeperTick(h.s, { waitMs: 0 });
    expect(r1.quotes_closed).toBe(1);
    expect(r1.jobs_requeued).toBe(1);
    expect((await (await h.request(`/v1/quotes/${final.quote_id}`)).json()).status).toBe("expired");
    h.advance(400);
    const r2 = await keeperTick(h.s, { waitMs: 0 });
    expect(r2.quotes_closed).toBe(1);
    expect(r2.jobs_abandoned).toBe(1);
    expect((await (await h.request(`/v1/quotes/${draft.quote_id}`)).json()).status).toBe("cancelled");
  });

  it("refreshes the OFAC list when it is older than OFAC_REFRESH_S", async () => {
    const h = new Harness({ sanctionsFetchedAgoS: 7 * 3600 });
    const list = Array.from({ length: 20 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, "0")}`);
    h.listFetch = async () => new Response(JSON.stringify(list), { status: 200 });
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.sanctions).toBe("refreshed");
    const st = await h.s.sanctions.status();
    expect(st).toMatchObject({ fresh: true, count: 20, fetched_at: h.nowS() });
  });
});

describe("keeper lease", () => {
  it("overlapping ticks do not run concurrently; a crashed holder's lease expires", async () => {
    const h = new Harness();
    const [a, b] = await Promise.all([keeperTick(h.s, { waitMs: 0 }), keeperTick(h.s, { waitMs: 0 })]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
    expect((await keeperTick(h.s, { waitMs: 0 })).skipped).toBe(false); // released after the tick
    await h.repo.acquireLock("keeper", "crashed-isolate", h.nowS(), 55);
    expect((await keeperTick(h.s, { waitMs: 0 })).skipped).toBe(true);
    h.advance(56);
    expect((await keeperTick(h.s, { waitMs: 0 })).skipped).toBe(false);
  });
});

describe("sanctions list", () => {
  it("screens case-insensitively and refuses malformed or suspiciously shrunken lists", async () => {
    const h = new Harness();
    const s = h.s.sanctions as Sanctions;
    const listed = `0x${"1".padStart(40, "0")}`;
    expect(await s.screen(listed.toUpperCase().replace("0X", "0x"))).toBe("sanctioned");
    expect(await s.screen(h.buyer.address)).toBe("clear");
    h.listFetch = async () => new Response(JSON.stringify(["0xnotanaddress"]));
    expect(await s.refresh()).toEqual({ ok: false, error: "malformed_list" });
    h.listFetch = async () =>
      new Response(JSON.stringify(Array.from({ length: 3 }, (_, i) => `0x${String(i).padStart(40, "0")}`)));
    expect(await s.refresh()).toEqual({ ok: false, error: "list_too_small" });
    h.listFetch = async () => new Response("{}", { status: 500 });
    expect(await s.refresh()).toEqual({ ok: false, error: "http_500" });
    expect(await s.screen(listed)).toBe("sanctioned"); // previous list kept
  });
});
