import { keyframeFactoryAbi, Status, USDC } from "@keyframe/protocol";
import { decodeFunctionData, type Hex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { viemChainReader } from "../src/chain.js";
import { keeperTick } from "../src/keeper.js";
import { SANCTIONED_SENDER } from "../src/orders/direct.js";
import { allWithin, covers, type FakeLog, type FakeRpc, startFakeRpc, transferLog } from "./support/fake-rpc.js";
import { Harness, SANCTIONED } from "./support/harness.js";

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

// Production bug (Base mainnet, Alchemy free-tier RPC_URL): the sender screening read Transfer logs over a fixed
// 2000-block lookback, every eth_getLogs above 10 blocks was refused, screening failed closed with
// direct_transfer_logs_failed and no direct-rail deposit was ever registered (e2e step 7.4).
describe("direct rail sender screening when the logs RPC refuses wide ranges", () => {
  const HEAD = 40_000_000n;
  const rpcs: FakeRpc[] = [];
  afterAll(async () => {
    await Promise.all(rpcs.map((r) => r.close()));
  });

  /** RPC_URL and LOGS_RPC_URL both behave like Alchemy's free tier (≤ 10 blocks inclusive per eth_getLogs). */
  async function withRealLogs(h: Harness, logs: FakeLog[]) {
    const main = await startFakeRpc({ head: HEAD, logs, maxRange: 10 });
    const pub = await startFakeRpc({ head: HEAD, logs, maxRange: 10 });
    rpcs.push(main, pub);
    const real = viemChainReader(main.url, { logsRpcUrl: pub.url, logsMaxRange: 2_000 });
    h.chain.transfersTo = (token, to, q) => real.transfersTo(token, to, q);
    return { main, pub };
  }

  it("a clean deposit is screened through ≤ 10-block chunks from the quote's creation and the order opens", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const amount = BigInt(q.terms.amount);
    const { main, pub } = await withRealLogs(h, [transferLog(USDC, h.buyer.address, q.escrow, amount, HEAD - 4n)]);
    fund(h, q.escrow, amount);
    h.advance(100); // quote created 100 s ago (plus the render): the scan starts ~50 + 30 blocks back
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.direct_opened).toBe(1);
    expect(h.relayer.count("register")).toBe(1);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
    const row = await h.repo.getQuote(q.quote_id);
    const from = HEAD - BigInt(Math.ceil((h.nowS() - (row?.created_at ?? 0)) / 2) + 30);
    expect(pub.ranges).toEqual([[from, HEAD - 10n]]); // refused (wider than 10 blocks)
    expect(allWithin(main.ranges, 10)).toBe(true);
    expect(covers(main.ranges, from, HEAD)).toBe(true);
    expect(HEAD - from).toBeLessThan(200n); // not the old fixed 2000-block lookback
  });

  it("a sanctioned sender found in an early chunk still refuses the quote", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const amount = BigInt(q.terms.amount);
    await withRealLogs(h, [
      transferLog(USDC, SANCTIONED.address, q.escrow, 1n, HEAD - 25n),
      transferLog(USDC, h.buyer.address, q.escrow, amount, HEAD - 1n),
    ]);
    fund(h, q.escrow, amount + 1n);
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.direct_opened).toBe(0);
    expect(h.relayer.count("register")).toBe(0);
    expect((await h.repo.getQuote(q.quote_id))?.cancel_reason).toBe(SANCTIONED_SENDER);
  });

  it("a deposit older than the scan shows up as unattributed funds: fail closed, nothing registered", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const amount = BigInt(q.terms.amount);
    await withRealLogs(h, [transferLog(USDC, h.buyer.address, q.escrow, amount, HEAD - 5_000n)]);
    fund(h, q.escrow, amount);
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.direct_opened).toBe(0);
    expect(h.relayer.count("register")).toBe(0);
    expect((await h.repo.getQuote(q.quote_id))?.status).toBe("final");
  });

  it("call sites bound every log lookup by a known time", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    fund(h, q.escrow, 1_000_000n);
    await keeperTick(h.s, { waitMs: 0 });
    const row = await h.repo.getQuote(q.quote_id);
    const t = h.chain.logQueries.find((x) => x.kind === "Transfer");
    expect(t?.q).toMatchObject({ sinceS: row?.created_at, nowS: h.nowS() });
    expect(typeof t?.q?.deadlineMs).toBe("number");
  });
});
