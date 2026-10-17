import { decisionTypedData, Status } from "@keyframe/protocol";
import { keccak256, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { keeperTick } from "../src/keeper.js";
import { encodeFactoryCall } from "../src/orders/lifecycle.js";
import { checkPolicy } from "../src/quotes/policy.js";
import { parseQuoteRequest } from "../src/quotes/request.js";
import { DROP_CONFIRM_S, RelayerCore, type RelayerStore, type StoredTx } from "../src/relayer/core.js";
import { changeRequestTypedData } from "../src/reviews.js";
import { Harness, type Json, SANCTIONED } from "./support/harness.js";

// Regression tests for the API security review (ADR-019), lifecycle / keeper / relayer / throttling. Each block
// ports one PoC (poc-*.test.ts) with the assertion inverted, or covers a finding without a PoC; all of them failed
// on the code before the fix.

const BRIEF = "A confident ten second sting for a parachute-themed DeFi safety brand, calm and precise.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function paidStudio(h: Harness) {
  const q = await h.createQuote({ format: "studio", params: { deliverable: "studio_sting", brief: BRIEF } });
  const paid = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
  await h.drain();
  return { q, paid };
}

async function requestChanges(h: Harness, q: Json, paid: Json) {
  const cc = await (
    await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, { access_token: paid.access_token, decision: "changes" })
  ).json();
  const sig = await h.buyer.signTypedData(changeRequestTypedData(q.terms_hash, cc.sig_deadline, h.s.cfg.factory));
  return (
    await h.postJson(`/v1/reviews/${paid.order_id}/submit`, {
      access_token: paid.access_token,
      decision: "changes",
      signature: sig,
      sig_deadline: cc.sig_deadline,
    })
  ).json();
}

describe("M2 Studio change requests (poc-changes)", () => {
  it("after 'changes': one revision can be delivered, silence never releases, an explicit late accept does", async () => {
    const h = new Harness();
    const { q, paid } = await paidStudio(h);
    await h.deliverStudio(paid.order_id);
    const sub = await requestChanges(h, q, paid);
    expect(sub).toMatchObject({ status: "changes_requested" });
    expect(sub.policy).toMatch(/never releases payment on silence/);

    // the designer delivers the revision (off-chain; the contract knows one deliver)
    const rev = await h.deliverStudio(paid.order_id);
    expect(rev).toMatchObject({ state: "revision_delivered", tx: null });
    expect(h.relayer.count("deliver")).toBe(1);
    const view = await (await h.request(`/v1/orders/${paid.order_id}?token=${paid.access_token}`)).json();
    expect(view.status).toBe("delivered");
    expect(view.changes.revision.manifest_hash).toBe(rev.manifest_hash);
    expect(view.changes.revision.preview_url).toMatch(/\/files\/p\/q_/);
    // only one revision
    expect((await h.internal(`/studio/orders/${paid.order_id}/delivery`, { method: "POST" })).status).toBe(409);

    // the review window ends with no decision: NOT released
    h.advance(86_400 + 1);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Delivered);
    expect(h.relayer.count("release")).toBe(0);

    // the buyer accepts after the on-chain window (verified off-chain) → released
    const ch = await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, {
      access_token: paid.access_token,
      decision: "accept",
    });
    expect(ch.status).toBe(200);
    const c = await ch.json();
    const signature = await h.buyer.signTypedData(
      decisionTypedData(q.terms_hash, true, c.sig_deadline, h.s.cfg.factory),
    );
    const ok = await h.postJson(`/v1/reviews/${paid.order_id}/submit`, {
      access_token: paid.access_token,
      decision: "accept",
      signature,
      sig_deadline: c.sig_deadline,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toBe("accepted");
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("after 'changes' with no accept, the keeper refunds at review end + grace", async () => {
    const h = new Harness();
    const { q, paid } = await paidStudio(h);
    await h.deliverStudio(paid.order_id);
    await requestChanges(h, q, paid);
    h.advance(86_400 + 1);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Delivered);
    h.advance(3 * 86_400);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Refunded);
    expect(h.relayer.count("release")).toBe(0);
    expect((await (await h.request(`/v1/orders/${paid.order_id}`)).json()).status).toBe("returned");
  });
});

describe("M3 inconsistent RPC reads (poc-dropped)", () => {
  function core(client: Record<string, unknown>, at: { now: number }, store = new Map<string, unknown>()) {
    const s: RelayerStore = {
      getNonce: async () => 8,
      putNonce: async () => {},
      putTx: async (h, t) => void store.set(`tx:${h}`, t),
      getTx: async (h) => store.get(`tx:${h}`) as StoredTx | undefined,
      deleteTx: async (h) => void store.delete(`tx:${h}`),
    };
    return new RelayerCore({
      account: privateKeyToAccount(generatePrivateKey()),
      client: client as never,
      factory: "0x00000000000000000000000000000000000f4c70",
      chainId: 8453,
      store: s,
      nowS: () => at.now,
    });
  }

  it("a lagging node (no receipt, nonce already used) does not turn a mined tx into 'dropped'", async () => {
    const store = new Map<string, unknown>();
    const raw = "0x02f8" as const;
    const hash = keccak256(raw);
    store.set(`tx:${hash}`, { raw, nonce: 7, kind: "fund", ref: "x", sentAt: 0 } satisfies StoredTx);
    let receiptCalls = 0;
    const lagging = {
      getTransactionReceipt: async () => {
        receiptCalls++;
        if (receiptCalls < 2) throw new Error("TransactionReceiptNotFoundError"); // lagging node
        return { status: "success", blockNumber: 9n, logs: [] } as unknown as TransactionReceipt; // up-to-date node
      },
      getTransaction: async () => {
        throw new Error("TransactionNotFoundError");
      },
      getTransactionCount: async () => 8,
    };
    const at = { now: 1000 };
    expect(await core(lagging, at, store).receipt(hash, 0)).toMatchObject({ state: "confirmed" });
  });

  it("reports dropped only after the nonce-used-without-receipt view persists for DROP_CONFIRM_S", async () => {
    const store = new Map<string, unknown>();
    const raw = "0x02f9" as const;
    const hash = keccak256(raw);
    store.set(`tx:${hash}`, { raw, nonce: 7, kind: "fund", ref: "x", sentAt: 0 } satisfies StoredTx);
    const client = {
      getTransactionReceipt: async () => {
        throw new Error("TransactionReceiptNotFoundError");
      },
      getTransaction: async () => {
        throw new Error("TransactionNotFoundError");
      },
      getTransactionCount: async () => 8,
    };
    const at = { now: 1000 };
    const c = core(client, at, store);
    expect(await c.receipt(hash, 0)).toMatchObject({ state: "pending" });
    at.now += DROP_CONFIRM_S - 1;
    expect(await c.receipt(hash, 0)).toMatchObject({ state: "pending" });
    at.now += 2;
    expect(await c.receipt(hash, 0)).toMatchObject({ state: "reverted", reason: "dropped (nonce reused)" });
  });

  it("confirmFunding re-reads order(termsHash): a funded order reported 'dropped' is released, not failed", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.slowReceipts = true;
    const body = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    expect(body.funding).toBe("pending");
    h.relayer.mine(body.funding_tx); // the tx IS mined: T is Open with funds
    h.relayer.slowReceipts = false;
    h.relayer.receipt = async (hash) => ({ state: "reverted", hash, reason: "dropped (nonce reused)" });
    await h.drain();
    await keeperTick(h.s, { waitMs: 0 });
    const st = await (await h.request(`/v1/orders/${body.order_id}`)).json();
    expect(st.status).toBe("key_published");
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });
});

describe("M4 relayer gas griefing (poc-rail, poc-refundexpired)", () => {
  it("N concurrent /rail calls for late funds produce at most one cancel", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.advance(601); // quote expired, never paid
    h.factory.balances.set(q.escrow.toLowerCase(), 1_000_000n);
    const N = 8;
    await Promise.all(Array.from({ length: N }, () => h.request(`/v1/quotes/${q.quote_id}/rail`, { method: "POST" })));
    expect(h.relayer.count("cancel")).toBeLessThanOrEqual(1);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Cancelled);
  });

  it("dust at an unpayable quote's escrow costs the relayer nothing", async () => {
    const h = new Harness();
    const draft = await h.createQuote(); // never rendered
    h.advance(901);
    await keeperTick(h.s, { waitMs: 0 });
    h.factory.balances.set(draft.escrow.toLowerCase(), 1n);
    const r = await (await h.request(`/v1/quotes/${draft.quote_id}/rail`, { method: "POST" })).json();
    expect(r.outcome).toBe("dust");
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.relayer.count("cancel")).toBe(0);
  });

  it("POST /v1/quotes/{id}/rail is rate limited per client", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++)
      codes.push((await h.request(`/v1/quotes/${q.quote_id}/rail`, { method: "POST" })).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // another client is not affected
    const other = await h.request(`/v1/quotes/${q.quote_id}/rail`, {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
    });
    expect(other.status).toBe(200);
  });

  it("an entry refundExpired cannot clear never becomes a relayer tx per tick", async () => {
    const h = new Harness();
    const stuck = `0x${"ab".repeat(32)}`;
    h.factory.views.set(stuck, {
      status: Status.Open,
      buyer: "0x000000000000000000000000000000000000dEaD",
      deadline: BigInt(h.nowS() - 10),
      reviewWindow: 0,
      openedAt: 0n,
      deliveredAt: 0n,
      finalAt: 0n,
      accepted: false,
      key: `0x${"0".repeat(64)}`,
      manifestHash: `0x${"0".repeat(64)}`,
      toSeller: 0n,
      toBuyer: 0n,
    });
    h.factory.stuck.add(stuck);
    for (let i = 0; i < 5; i++) {
      await keeperTick(h.s, { waitMs: 0 });
      h.advance(60);
    }
    expect(h.relayer.count("refund_expired")).toBe(0);
    // a clearable third-party registration is swept once, and then there is nothing left to send
    h.factory.stuck.clear();
    for (let i = 0; i < 3; i++) {
      await keeperTick(h.s, { waitMs: 0 });
      h.advance(60);
    }
    expect(h.relayer.count("refund_expired")).toBe(1);
  });

  it("the relayer refuses non-fund sends beyond its hourly budget (fund still goes through) and alarms on low ETH", async () => {
    const logs: string[] = [];
    const client = {
      estimateGas: async () => 50_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getTransactionCount: async () => 0,
      sendRawTransaction: async () => "0x",
      getBalance: async () => 10n,
    };
    const store = new Map<string, unknown>();
    const core = new RelayerCore({
      account: privateKeyToAccount(generatePrivateKey()),
      client: client as never,
      factory: "0x00000000000000000000000000000000000f4c70",
      chainId: 8453,
      store: {
        getNonce: async () => store.get("nonce") as number | undefined,
        putNonce: async (n) => void store.set("nonce", n),
        putTx: async (h, t) => void store.set(`tx:${h}`, t),
        getTx: async (h) => store.get(`tx:${h}`) as StoredTx | undefined,
        deleteTx: async (h) => void store.delete(`tx:${h}`),
      },
      maxTxPerHour: 2,
      lowBalanceWei: 1_000n,
      log: (_level, event) => void logs.push(event),
    });
    const send = (kind: "release" | "fund") => core.send({ kind, ref: "o", data: "0x1234", waitMs: 0 });
    expect((await send("release")).state).toBe("pending");
    expect((await send("release")).state).toBe("pending");
    expect(await send("release")).toMatchObject({ state: "unavailable", reason: expect.stringContaining("budget") });
    expect((await send("fund")).state).toBe("pending");
    expect(logs).toContain("relayer_tx_budget_exceeded");
    expect(logs).toContain("relayer_low_balance");
  });
});

describe("M5 direct rail screens every sender", () => {
  it("USDC from a sanctioned address at E: not registered, not served, funds left refundable to T.buyer", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const e = q.escrow.toLowerCase();
    h.factory.balances.set(e, 1_000_000n);
    h.factory.transfers.set(e, [{ from: SANCTIONED.address, value: 1_000_000n, tx: `0x${"5a".repeat(32)}` }]);
    await keeperTick(h.s, { waitMs: 0 });
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.relayer.sends).toHaveLength(0);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.None);
    const quote = await (await h.request(`/v1/quotes/${q.quote_id}`)).json();
    expect(quote).toMatchObject({ status: "cancelled", cancel_reason: "sanctioned_sender" });
    expect(h.factory.balances.get(e)).toBe(1_000_000n);
  });
});

describe("M6 throttling, render queue fairness, capped bodies (poc-quoteflood)", () => {
  it("one client with random buyer addresses cannot flood the render queue; a real buyer elsewhere is served", async () => {
    const h = new Harness();
    const attacker = { "cf-connecting-ip": "203.0.113.7" };
    const codes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const r = await h.postJson(
        "/v1/quotes",
        h.quoteBody({ buyer: privateKeyToAccount(generatePrivateKey()).address }),
        attacker,
      );
      codes.push(r.status);
    }
    expect(codes.filter((c) => c === 201).length).toBeLessThanOrEqual(3);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(197);
    const real = await h.postJson("/v1/quotes", h.quoteBody(), { "cf-connecting-ip": "198.51.100.9" });
    expect(real.status).toBe(201);
    const realId = (await real.json()).quote_id;
    const depth = h.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'")[0]?.n ?? 0;
    expect(depth).toBeLessThanOrEqual(4);
    const claimed: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await h.internal("/jobs/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "worker-1" }),
      });
      claimed.push((await c.json()).quote_id);
    }
    expect(claimed).toContain(realId);
  }, 60_000);

  it("the worker claims round-robin across clients, not FIFO", async () => {
    const h = new Harness({ env: { MAX_QUEUED_RENDERS_PER_CLIENT: "10", QUOTES_PER_BUYER_PER_HOUR: "100" } });
    for (let i = 0; i < 10; i++) {
      const r = await h.postJson("/v1/quotes", h.quoteBody(), { "cf-connecting-ip": "203.0.113.7" });
      expect(r.status).toBe(201);
      h.advance(1); // well-defined FIFO order for the old claim query
    }
    const real = await h.postJson("/v1/quotes", h.quoteBody(), { "cf-connecting-ip": "198.51.100.9" });
    const realId = (await real.json()).quote_id;
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await h.internal("/jobs/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: `w${i}` }),
      });
      order.push((await c.json()).quote_id);
    }
    expect(order.indexOf(realId)).toBe(1);
  });

  it("bodies are capped while streaming: an oversized chunked body is cut off, not buffered", async () => {
    const h = new Harness();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 128) return c.close();
        c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    const res = await h.request("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(8);
    const declared = await h.request("/v1/auth/siwe/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: "{}",
    });
    expect(declared.status).toBe(413);
  });

  it("the global render queue is capped", async () => {
    const h = new Harness({ env: { MAX_QUEUED_RENDERS: "2", QUOTES_PER_BUYER_PER_HOUR: "100" } });
    const ip = (i: number) => ({ "cf-connecting-ip": `198.51.100.${i}` });
    expect((await h.postJson("/v1/quotes", h.quoteBody(), ip(1))).status).toBe(201);
    expect((await h.postJson("/v1/quotes", h.quoteBody(), ip(2))).status).toBe(201);
    const third = await h.postJson("/v1/quotes", h.quoteBody(), ip(3));
    expect(third.status).toBe(503);
    expect((await third.json()).error).toBe("render_queue_full");
  });
});

describe("L1 release margin and pre-read", () => {
  it("no release is sent within 120 s of the Instant deadline; the order is refunded after it", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) => (req.kind === "release" ? { state: "unavailable", reason: "rpc down" } : undefined);
    await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    await h.drain();
    const before = h.relayer.count("release");
    h.relayer.override = null;
    h.advance(q.deadline - h.nowS() - 60);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.relayer.count("release")).toBe(before);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open);
    h.advance(61);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Refunded);
  });

  it("a Studio buyer who rejected on-chain directly: no release calldata (K_chain) is ever built or sent", async () => {
    const h = new Harness();
    const { q, paid } = await paidStudio(h);
    await h.deliverStudio(paid.order_id);
    // the buyer calls decide(T, false) on Base directly (keyframe_refund action reject)
    expect(
      h.factory.apply(encodeFactoryCall.decideBySig(h.terms(q), false, BigInt(h.nowS() + 600), "0x00")),
    ).toBeNull();
    h.advance(86_400);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.relayer.count("release")).toBe(0);
    const st = await (await h.request(`/v1/orders/${paid.order_id}`)).json();
    expect(st.status).toBe("returned");
  });
});

describe("L3 keeper phases stay inside the lease", () => {
  it("a slow phase is cut at its own budget and later phases still run", async () => {
    const h = new Harness();
    h.relayer.override = (req) => (req.kind === "release" ? { state: "unavailable", reason: "x" } : undefined);
    for (let i = 0; i < 5; i++) {
      const q = await h.finalQuote();
      await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    }
    await h.drain();
    h.relayer.override = null;
    const send = h.relayer.send.bind(h.relayer);
    h.relayer.send = async (req) => {
      if (req.kind === "release") await sleep(600);
      return send(req);
    };
    // a third-party registration refundExpired can clear, so the refund_expired phase has work
    h.factory.views.set(`0x${"cd".repeat(32)}`, {
      ...h.factory.view(`0x${"00".repeat(32)}`),
      status: Status.Open,
      buyer: "0x000000000000000000000000000000000000bEEF",
      deadline: BigInt(h.nowS() - 10),
    });
    const t0 = Date.now();
    const r = await keeperTick(h.s, { waitMs: 0, budgetMs: 3_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.orders_advanced).toBeLessThan(5);
    expect(r.refund_expired_sent).toBe(true);
  });
});

describe("L4 content policy normalisation (poc-policy)", () => {
  const now = Math.floor(Date.now() / 1000);
  const countdown = (label: string) =>
    parseQuoteRequest({
      buyer: `0x${"1".repeat(40)}`,
      format: "countdown",
      rights_confirmed: true,
      params: { style: "tminus", label, target: new Date((now + 86400) * 1000).toISOString() },
    });
  const verdict = (label: string) => {
    const p = countdown(label);
    if (!p.ok) throw new Error(JSON.stringify(p));
    return checkPolicy(p.request, now);
  };
  for (const [name, label] of [
    ["cyrillic homoglyph", "nаzi rally"],
    ["fullwidth", "ｎａｚｉ rally"],
    ["split by punctuation", "n.a.z.i rally"],
    ["spaced letters", "n a z i rally"],
    ["leetspeak", "n4z1 rally"],
    ["word joiner inside", "na⁠zi rally"],
    ["bare domain (no slash)", "claim at drainer.com"],
    ["unlisted tld with path", "go drainer.co/claim"],
    ["fullwidth domain", "drainer．com"],
  ] as const) {
    it(`refuses ${name}`, () => expect(verdict(label).ok).toBe(false));
  }
  for (const label of ["Mainnet", "Block 1515", "Join us at 9pm", "T-minus 3 days", "Season 2"]) {
    it(`still accepts "${label}"`, () => expect(verdict(label).ok).toBe(true));
  }
  it("checks nested catalog values", () => {
    const p = parseQuoteRequest({
      buyer: `0x${"1".repeat(40)}`,
      format: "catalog",
      rights_confirmed: true,
      params: { catalog_id: "probe", values: { x: ["nazi", "https://drainer.com/x"], y: { z: "seed phrase" } } },
    });
    if (!p.ok) throw new Error(JSON.stringify(p));
    expect(checkPolicy(p.request, now).ok).toBe(false);
  });
});

describe("L5 drafts never present a payable escrow", () => {
  it("draft quotes mark terms/escrow provisional; final quotes are payable", async () => {
    const h = new Harness();
    const draft = await h.createQuote();
    expect(draft).toMatchObject({
      status: "draft",
      payable: false,
      terms_final: false,
      escrow_status: "provisional_do_not_pay",
    });
    expect(draft.notice).toMatch(/Do not pay/);
    await h.render();
    const final = await (await h.request(`/v1/quotes/${draft.quote_id}`)).json();
    expect(final).toMatchObject({ status: "final", payable: true, terms_final: true });
    expect(final.escrow).not.toBe(draft.escrow); // the provisional escrow was never payable
    expect(final.escrow_status).toBeUndefined();
  });
});

describe("INFO items", () => {
  it("access_token is accepted as Authorization: Bearer on the order view", async () => {
    const h = new Harness();
    const q = await h.finalQuote({ delivery: "private" });
    const paid = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    const own = await (
      await h.request(`/v1/orders/${paid.order_id}`, { headers: { authorization: `Bearer ${paid.access_token}` } })
    ).json();
    expect(own).toMatchObject({ access: "owner", k_buyer: paid.k_buyer });
    const bad = await h.request(`/v1/orders/${paid.order_id}`, {
      headers: { authorization: `Bearer ${"A".repeat(43)}` },
    });
    expect(bad.status).toBe(401);
  });

  it("deadline_minutes below MIN_RELEASE_MARGIN_S is refused at quote time", async () => {
    const h = new Harness({ env: { MIN_RELEASE_MARGIN_S: "600" } });
    const r = await h.postJson("/v1/quotes", h.quoteBody({ deadline_minutes: 5 }));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe("deadline_too_short");
    expect((await h.postJson("/v1/quotes", h.quoteBody({ deadline_minutes: 10 }))).status).toBe(201);
  });

  it("a kill fee above 5000 bps is a configuration problem, never quoted", () => {
    const cfg = parseConfig({ STUDIO_KILL_FEE_BPS: "6000" });
    expect(cfg.problems.some((p) => p.includes("STUDIO_KILL_FEE_BPS"))).toBe(true);
    expect(cfg.studioKillFeeBps).toBeLessThanOrEqual(5000);
  });

  it("refund_tx is filled from the Refunded event when someone else refunded", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) =>
      req.kind === "release" || req.kind === "refund" ? { state: "unavailable", reason: "x" } : undefined;
    const paid = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    await h.drain();
    h.relayer.override = null;
    h.advance(q.deadline - h.nowS() + 1);
    // the buyer refunds on Base directly
    expect(h.factory.apply(encodeFactoryCall.refund(h.terms(q)))).toBeNull();
    await keeperTick(h.s, { waitMs: 0 });
    const st = await (await h.request(`/v1/orders/${paid.order_id}`)).json();
    expect(st).toMatchObject({ status: "returned", refund_tx: `0x${"ee".repeat(32)}`, to_buyer: "1000000" });
  });
});
