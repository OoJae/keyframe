import {
  deriveKChain,
  keyframeFactoryAbi,
  keyHashOf,
  PaidResponseSchema,
  Status,
  termsFromJson,
} from "@keyframe/protocol";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/client";
import { decodeFunctionData, type Hex, hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkAccessToken } from "../src/orders/access.js";
import { Harness, SANCTIONED } from "./support/harness.js";

// Paid path (architecture.md §c.3): verify → business checks → CAS → settle → 200, with a real x402 client
// signing real EIP-3009 authorizations and the stub relayer standing in for the Durable Object.

const fundCalls = (h: Harness) => h.relayer.sends.filter((r) => r.kind === "fund");

describe("paid path", () => {
  it("happy path: 200 paid body (§7), one fundWithAuthorization, then release with K_chain", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    const res = await h.pay(q.quote_id, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("payment-response")).toBeTruthy();
    const body = PaidResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      quote_id: q.quote_id,
      terms_hash: q.terms_hash,
      escrow: q.escrow,
      amount: "1000000",
      deadline: q.deadline,
      funding: "confirmed",
      k_buyer: null,
      next: "keyframe_verify",
    });
    expect(body.status_url).toBe(`https://api.keyframe.test/v1/orders/${body.order_id}`);
    expect(await checkAccessToken(h.s.cfg.secrets.accessSecret as Uint8Array, body.order_id, body.access_token)).toBe(
      true,
    );
    const settle = JSON.parse(Buffer.from(res.headers.get("payment-response") ?? "", "base64").toString());
    expect(settle).toMatchObject({ success: true, transaction: body.funding_tx, network: "eip155:8453" });

    // exactly one funding call, and it is fundWithAuthorization(T, …) for the quoted T and the buyer's auth
    const funds = fundCalls(h);
    expect(funds).toHaveLength(1);
    const call = decodeFunctionData({ abi: keyframeFactoryAbi, data: funds[0]?.data as Hex });
    expect(call.functionName).toBe("fundWithAuthorization");
    const t = termsFromJson(q.terms);
    const sent = call.args[0] as Record<string, unknown>;
    expect({ ...sent, dueAt: Number(sent.dueAt), deadline: Number(sent.deadline) }).toEqual(t);

    // background: release(T, K_chain, charge = amount, manifestHash = contentHash)
    await h.drain();
    const rel = h.relayer.sends.filter((r) => r.kind === "release");
    expect(rel).toHaveLength(1);
    const r = decodeFunctionData({ abi: keyframeFactoryAbi, data: rel[0]?.data as Hex });
    const [, key, charge, manifestHash] = r.args as [unknown, Hex, bigint, Hex];
    expect(key).toBe(await deriveKChain(hexToBytes(h.kmasterHex), q.quote_id));
    expect(keyHashOf(key)).toBe(t.keyHash);
    expect(charge).toBe(1_000_000n);
    expect(manifestHash).toBe(t.contentHash);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);

    const status = await (await h.request(`/v1/orders/${body.order_id}?token=${body.access_token}`)).json();
    expect(status).toMatchObject({
      status: "key_published",
      access: "owner",
      release_tx: expect.stringMatching(/^0x/),
    });
    const quoteAfter = await (await h.request(`/v1/quotes/${q.quote_id}`)).json();
    expect(quoteAfter.status).toBe("paid");
    expect(quoteAfter.order_id).toBe(body.order_id);
    const stats = await (await h.request("/v1/stats")).json();
    expect(stats).toMatchObject({
      quotes: 1,
      orders: 1,
      delivered: 1,
      open: 0,
      escrowed_atomic: "1000000",
      paid_to_studio_atomic: "1000000",
    });
  });

  it("idempotent replay: the same authorization returns the same bytes and never settles twice", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    const a = await h.pay(q.quote_id, headers, "POST");
    const b = await h.pay(q.quote_id, headers, "GET");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(await a.text());
    expect(b.headers.get("payment-response")).toBe(a.headers.get("payment-response"));
    expect(fundCalls(h)).toHaveLength(1);
  });

  it("10 parallel retries of one authorization settle exactly once and all get the same body", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    const results = await Promise.all(Array.from({ length: 10 }, () => h.pay(q.quote_id, headers)));
    const bodies = await Promise.all(results.map((r) => r.text()));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(bodies).size).toBe(1);
    expect(fundCalls(h)).toHaveLength(1);
  });

  it("parallel different authorizations for one quote: one 200, the rest 409, one settlement", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const auths = await Promise.all(Array.from({ length: 5 }, () => h.paymentHeaders(q.quote_id)));
    const results = await Promise.all(auths.map((a) => h.pay(q.quote_id, a)));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect((await r.json()).charged).toBe(false);
    expect(fundCalls(h)).toHaveLength(1);
    // and afterwards the quote answers 409 already_paid without a 402
    const after = await h.request(`/v1/orders/${q.quote_id}`);
    expect(after.status).toBe(409);
    expect(after.headers.get("payment-required")).toBeNull();
  });

  it("wrong payer → 409 payer_mismatch, not charged, nothing sent", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id, stranger));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "payer_mismatch", charged: false });
    expect(h.relayer.sends).toHaveLength(0);
    // the quote is still payable by the right wallet
    expect((await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).status).toBe(200);
  });

  it("expired quote → 410 for paid requests too, nothing sent", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    h.advance(601);
    const res = await h.pay(q.quote_id, headers);
    expect(res.status).toBe(410);
    expect((await res.json()).charged).toBe(false);
    expect(h.relayer.sends).toHaveLength(0);
  });

  it("sanctioned payer → 451, nothing sent", async () => {
    const h = new Harness();
    const q = await h.finalQuote({ buyer: h.buyer.address });
    // the list gains the buyer after quoting
    const list = JSON.parse(
      h.db.query<{ addresses: string }>("SELECT addresses FROM sanctions_lists")[0]?.addresses ?? "[]",
    );
    h.db.raw
      .prepare("UPDATE sanctions_lists SET addresses = ?")
      .run(JSON.stringify([...list, h.buyer.address.toLowerCase()]));
    h.advance(61); // isolate cache
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(451);
    expect(h.relayer.sends).toHaveLength(0);
    expect(SANCTIONED.address).toBeTruthy();
  });

  it("at capacity → 503, nothing sent", async () => {
    const h = new Harness({ env: { MAX_INFLIGHT_ORDERS: "1" } });
    const first = await h.finalQuote();
    h.relayer.slowReceipts = true; // first order stays in flight (funding pending)
    expect((await h.pay(first.quote_id, await h.paymentHeaders(first.quote_id))).status).toBe(200);
    const second = await h.finalQuote();
    const res = await h.pay(second.quote_id, await h.paymentHeaders(second.quote_id));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "at_capacity", charged: false });
    expect(fundCalls(h)).toHaveLength(1);
  });

  it("verification failures answer 402 and never settle (tampered signature, simulation failure)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    const payload = JSON.parse(Buffer.from(headers["PAYMENT-SIGNATURE"] ?? "", "base64").toString());
    payload.payload.authorization.value = "999999";
    const tampered = { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") };
    const res = await h.pay(q.quote_id, tampered);
    expect(res.status).toBe(402);
    expect(h.relayer.sends).toHaveLength(0);

    h.chain.opts.simulationError = new Error("transfer amount exceeds balance");
    const res2 = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res2.status).toBe(402);
    expect(h.relayer.sends).toHaveLength(0);
  });

  it("settlement failure (relayer simulation revert) → 402 not charged, quote stays payable", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) =>
      req.kind === "fund" ? { state: "rejected", reason: "Error: FiatTokenV2: invalid signature" } : undefined;
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(402);
    const pr = JSON.parse(Buffer.from(res.headers.get("payment-response") ?? "", "base64").toString());
    expect(pr.success).toBe(false);
    expect((await (await h.request(`/v1/quotes/${q.quote_id}`)).json()).status).toBe("final");
    h.relayer.override = null;
    expect((await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).status).toBe(200);
  });

  it("relayer unavailable → PayAI fallback settles to E, then the API registers T", async () => {
    let fallbackCalls = 0;
    let h: Harness;
    const fallback: FacilitatorClient = {
      verify: async () => ({ isValid: true }),
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
      settle: async (payload, req) => {
        fallbackCalls++;
        // PayAI executes transferWithAuthorization(buyer → E): E is funded, T unregistered.
        const e = req.payTo.toLowerCase();
        h.factory.balances.set(e, (h.factory.balances.get(e) ?? 0n) + BigInt(req.amount));
        return {
          success: true,
          transaction: `0x${"fa".repeat(32)}`,
          network: req.network,
          payer: (payload.payload as { authorization: { from: string } }).authorization.from,
        };
      },
    };
    h = new Harness({ fallback });
    const q = await h.finalQuote();
    h.relayer.override = (req) =>
      req.kind === "fund" ? { state: "unavailable", reason: "insufficient funds for gas" } : undefined;
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.funding_tx).toBe(`0x${"fa".repeat(32)}`);
    expect(fallbackCalls).toBe(1);
    await h.drain();
    // the post-payment advance registers T, then (next attempt) releases without waiting for a keeper tick
    expect(h.relayer.sends.map((r) => r.kind)).toEqual(["fund", "register", "release"]);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("slow receipt → funding: pending; the keeper confirms and releases", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.slowReceipts = true;
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.funding).toBe("pending");
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.None);
    h.relayer.slowReceipts = false;
    h.relayer.mine(body.funding_tx);
    const { keeperTick } = await import("../src/keeper.js");
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
    const st = await (await h.request(`/v1/orders/${body.order_id}`)).json();
    expect(st.status).toBe("key_published");
    expect(st.funding).toBe("confirmed");
  });

  it("private delivery: k_buyer is in the paid body and only in the owner's status view", async () => {
    const h = new Harness();
    const q = await h.finalQuote({ delivery: "private" });
    const body = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    await h.drain();
    expect(body.k_buyer).toMatch(/^0x[0-9a-f]{64}$/);
    const pub = await (await h.request(`/v1/orders/${body.order_id}`)).json();
    expect(pub.k_buyer).toBeUndefined();
    expect(pub.quote_id).toBeUndefined();
    const own = await (await h.request(`/v1/orders/${body.order_id}?token=${body.access_token}`)).json();
    expect(own.k_buyer).toBe(body.k_buyer);
    expect((await h.request(`/v1/orders/${body.order_id}?token=${"A".repeat(43)}`)).status).toBe(401);
    const list = await (await h.request(`/v1/orders?buyer=${h.buyer.address}`)).json();
    expect(list.orders).toEqual([expect.objectContaining({ order_id: body.order_id, status: "key_published" })]);
  });

  it("v1 wire: a v1 client pays via X-PAYMENT and gets X-PAYMENT-RESPONSE", async () => {
    const h = new Harness({ env: { X402_WIRE: "v1" } });
    const q = await h.finalQuote();
    const challenge = await h.request(`/v1/orders/${q.quote_id}`, { method: "POST" });
    const client = new x402Client();
    client.registerV1("base", new ExactEvmSchemeV1(h.buyer));
    client.setSpendControls(false);
    const http = new x402HTTPClient(client);
    const required = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json());
    const headers = http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
    expect(Object.keys(headers)).toEqual(["X-PAYMENT"]);
    const res = await h.pay(q.quote_id, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-payment-response")).toBeTruthy();
    expect(res.headers.get("payment-response")).toBeNull();
    PaidResponseSchema.parse(await res.json());
    expect(fundCalls(h)).toHaveLength(1);
  });
});
