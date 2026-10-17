import { PaidResponseSchema, Status } from "@keyframe/protocol";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/client";
import { HttpRequestError } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { keeperTick } from "../src/keeper.js";
import { encodeFactoryCall } from "../src/orders/lifecycle.js";
import { redact } from "../src/redact.js";
import { Harness, type Json } from "./support/harness.js";

// Regression tests for the API security review (ADR-019), paid path. Each block ports one PoC from the review
// (poc-*.test.ts) with the assertion inverted: it failed on the code before the fix and passes after it.

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const quoteStatus = (h: Harness, id: string) =>
  h.db.query<{ status: string }>("SELECT status FROM quotes WHERE id = ?", id)[0]?.status;

describe("H1 orphaned settlement (poc-orphan)", () => {
  it("a transient D1 failure after fundWithAuthorization is retried inside the request: 200, order recorded", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const orig = h.repo.recordSettlement.bind(h.repo);
    let fail = true;
    h.repo.recordSettlement = async (...a) => {
      if (fail) {
        fail = false;
        throw new Error("D1_ERROR: Network connection lost");
      }
      return orig(...a);
    };
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    const body = PaidResponseSchema.parse(await res.json());
    expect(h.db.query("SELECT id FROM orders")).toEqual([{ id: body.order_id }]);
    expect(quoteStatus(h, q.quote_id)).toBe("paid");
  });

  it("persistent D1 failure: 503 charged:true, retries say charged:'unknown', the keeper adopts (same order id) and releases", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    const orig = h.repo.recordSettlement.bind(h.repo);
    h.repo.recordSettlement = async () => {
      throw new Error("D1_ERROR: Network connection lost");
    };
    const first = await h.pay(q.quote_id, headers);
    expect(first.status).toBe(503);
    const fb = (await first.json()) as Json;
    expect(fb).toMatchObject({ error: "settlement_recording_delayed", charged: true });
    expect(fb.order_id).toMatch(/^o_/);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open);

    const retry = await h.pay(q.quote_id, headers);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: "settlement_in_progress", charged: "unknown" });

    h.repo.recordSettlement = orig;
    h.advance(660);
    const report = await keeperTick(h.s, { waitMs: 0 });
    expect(report.settling_adopted).toBe(1);
    expect(quoteStatus(h, q.quote_id)).toBe("paid");
    expect(h.db.query("SELECT id FROM orders")).toEqual([{ id: fb.order_id }]);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);

    // long after settlement the replay carries no secrets and points at SIWE recovery
    const late = await h.pay(q.quote_id, headers);
    expect(late.status).toBe(200);
    const lb = (await late.json()) as Json;
    expect(lb).toMatchObject({ order_id: fb.order_id, access_token: null, k_buyer: null, secrets_withheld: true });
    expect(lb.recover.tool).toBe("keyframe_orders");
  }, 30_000);

  it("relayer call throws after broadcasting: adopted from the chain (200), never 402 + reopened", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) => {
      if (req.kind !== "fund") return undefined;
      h.factory.apply(req.data); // the DO broadcast and the tx was mined...
      throw new Error("Durable Object reset because its code was updated"); // ...but the RPC to the DO failed
    };
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    const body = PaidResponseSchema.parse(await res.json());
    expect(body.funding).toBe("confirmed");
    expect((await (await h.request(`/v1/quotes/${q.quote_id}`)).json()).status).toBe("paid");
    h.relayer.override = null;
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("relayer call throws and nothing is on-chain yet: charged 'unknown', claim kept, reopened only by the keeper", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    h.relayer.override = (req) => {
      if (req.kind === "fund") throw new Error("Network connection lost");
      return undefined;
    };
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "settlement_in_progress", charged: "unknown" });
    expect(quoteStatus(h, q.quote_id)).toBe("settling");
    // a second authorization cannot start a parallel settlement for the same quote
    const other = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(other.status).toBe(409);
    expect(h.relayer.count("fund")).toBe(1);
    // the keeper proves nothing moved (no funds at E, authorization unused) and only then lets the claim go
    h.advance(601);
    const r = await keeperTick(h.s, { waitMs: 0 });
    expect(r.settling_reconciled).toBe(1);
    expect(quoteStatus(h, q.quote_id)).not.toBe("settling");
    expect(h.db.query<{ status: string }>("SELECT status FROM payments")[0]?.status).toBe("failed");
  }, 30_000);

  it("the settlement promise is owned by waitUntil before money moves (a disconnect cannot cancel it)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    let atFund = -1;
    h.relayer.override = (req) => {
      if (req.kind === "fund") atFund = h.backgroundCount;
      return undefined;
    };
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    expect(atFund).toBeGreaterThanOrEqual(1);
  });

  it("10 orphans no longer starve the stale-settling reconciler (old LIMIT 10 ORDER BY updated_at)", async () => {
    const h = new Harness({ env: { QUOTES_PER_BUYER_PER_HOUR: "100" } });
    const orig = h.repo.recordSettlement.bind(h.repo);
    h.repo.recordSettlement = async () => {
      throw new Error("D1_ERROR");
    };
    for (let i = 0; i < 10; i++) {
      const q = await h.finalQuote();
      await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    }
    h.repo.recordSettlement = orig;
    // An 11th quote stuck in `settling` with NOTHING at E (isolate died before broadcasting): should be reopened.
    const victim = await h.finalQuote();
    h.advance(1);
    h.db.raw
      .prepare("UPDATE quotes SET status='settling', pay_from=?, pay_nonce=?, updated_at=? WHERE id=?")
      .run(h.buyer.address.toLowerCase(), `0x${"11".repeat(32)}`, h.nowS(), victim.quote_id);
    h.db.raw
      .prepare(
        "INSERT INTO payments (from_lc, nonce, quote_id, status, wire, created_at, updated_at) VALUES (?, ?, ?, 'settling', 'v2', ?, ?)",
      )
      .run(h.buyer.address.toLowerCase(), `0x${"11".repeat(32)}`, victim.quote_id, h.nowS(), h.nowS());
    h.advance(601);
    for (let i = 0; i < 3; i++) await keeperTick(h.s, { waitMs: 0 });
    expect(quoteStatus(h, victim.quote_id)).not.toBe("settling");
    expect(h.db.query("SELECT id FROM orders")).toHaveLength(10);
    expect(h.db.query("SELECT id FROM quotes WHERE status = 'settling'")).toHaveLength(0);
  }, 60_000);
});

describe("H2 paid-response replay (poc-replay)", () => {
  it("a forged header carrying the public (from, nonce) gets neither k_buyer nor access_token", async () => {
    const h = new Harness();
    const q = await h.finalQuote({ delivery: "private" });
    const headers = await h.paymentHeaders(q.quote_id);
    const legit = await h.pay(q.quote_id, headers);
    expect(legit.status).toBe(200);
    const body = await legit.json();
    expect(body.k_buyer).toMatch(/^0x[0-9a-f]{64}$/);

    const real = JSON.parse(Buffer.from(headers["PAYMENT-SIGNATURE"] ?? "", "base64").toString());
    const { from, nonce } = real.payload.authorization;
    const forged = {
      x402Version: 2,
      payload: {
        authorization: { from, to: from, value: "1", validAfter: "0", validBefore: "1", nonce },
        signature: "0xdead",
      },
    };
    const res = await h.pay(q.quote_id, { "PAYMENT-SIGNATURE": b64(forged) }, "GET");
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(text).not.toContain(body.k_buyer);
    expect(text).not.toContain(body.access_token);
    // even the exact signature, copied from fundWithAuthorization calldata into a re-encoded header, is refused
    const copied = {
      ...real,
      payload: { signature: real.payload.signature, authorization: real.payload.authorization },
    };
    const res2 = await h.pay(q.quote_id, { "PAYMENT-SIGNATURE": b64(copied) });
    const text2 = await res2.text();
    expect(text2).not.toContain(body.k_buyer);
  });

  it("the exact header replays byte-identically only briefly; afterwards secrets are null with a SIWE hint", async () => {
    const h = new Harness();
    const q = await h.finalQuote({ delivery: "private" });
    const headers = await h.paymentHeaders(q.quote_id);
    const a = await h.pay(q.quote_id, headers);
    const at = await a.text();
    const b = await h.pay(q.quote_id, headers, "GET");
    expect(await b.text()).toBe(at);
    h.advance(121);
    const c = await h.pay(q.quote_id, headers);
    expect(c.status).toBe(200);
    expect(c.headers.get("payment-response")).toBe(a.headers.get("payment-response"));
    const cb = (await c.json()) as Json;
    const ab = JSON.parse(at);
    expect(cb).toMatchObject({ order_id: ab.order_id, access_token: null, k_buyer: null, secrets_withheld: true });
    expect(cb.recover).toMatchObject({ tool: "keyframe_orders" });
    expect(h.relayer.count("fund")).toBe(1);
  });
});

describe("M1 dual payload payer confusion (poc-dualpayload)", () => {
  async function dualPayload(h: Harness, quoteId: string, buyer: string, escrow: string, amount: string) {
    const attacker = privateKeyToAccount(generatePrivateKey());
    const res = await h.request(`/v1/orders/${quoteId}`, { method: "POST" });
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: attacker });
    client.setSpendControls(false);
    const http = new x402HTTPClient(client);
    const required = http.getPaymentRequiredResponse((n) => res.headers.get(n), {});
    for (const a of required.accepts) a.extra = { ...a.extra, assetTransferMethod: "permit2" };
    const p = await http.createPaymentPayload(required); // attacker-signed Permit2 (to = E, amount)
    const inner = p.payload as Record<string, unknown>;
    inner.authorization = {
      from: buyer, // the victim
      to: escrow,
      value: amount,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"42".repeat(32)}`,
    };
    return { "PAYMENT-SIGNATURE": b64(p) };
  }

  it("Permit2 + EIP-3009 in one payload is refused: no k_buyer, no access_token, even with T already open", async () => {
    const h = new Harness();
    const q = await h.finalQuote({ delivery: "private" });
    h.factory.balances.set(q.escrow.toLowerCase(), BigInt(q.price.atomic));
    expect(h.factory.apply(encodeFactoryCall.register(h.terms(q)))).toBeNull();
    const r = await h.pay(q.quote_id, await dualPayload(h, q.quote_id, h.buyer.address, q.escrow, q.price.atomic));
    const body = await r.json();
    expect(r.status).not.toBe(200);
    expect(body.k_buyer).toBeUndefined();
    expect(body.access_token).toBeUndefined();
  });

  it("a non-buyer can no longer take the exactly-once claim (the quote never enters settling)", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    let sawSettling = false;
    h.relayer.override = (req) => {
      if (req.kind !== "fund") return undefined;
      sawSettling = quoteStatus(h, q.quote_id) === "settling";
      return { state: "rejected", reason: "Error: FiatTokenV2: invalid signature" };
    };
    const r = await h.pay(q.quote_id, await dualPayload(h, q.quote_id, h.buyer.address, q.escrow, q.price.atomic));
    expect(r.status).toBe(402);
    expect(sawSettling).toBe(false);
    expect(h.relayer.count("fund")).toBe(0);
  });

  it("the facilitator itself refuses non-EIP-3009 payloads (defence in depth)", async () => {
    const h = new Harness();
    const v = await h.s.facilitator.verify(
      {
        x402Version: 2,
        payload: { permit2Authorization: {}, authorization: { from: h.buyer.address }, signature: "0x00" },
      } as never,
      {} as never,
    );
    expect(v.isValid).toBe(false);
  });
});

describe("L2 PayAI fallback ambiguity", () => {
  const fallbackThat = (h: () => Harness, moveFunds: boolean): FacilitatorClient => ({
    verify: async () => ({ isValid: true }),
    getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    settle: async (_payload, req) => {
      if (moveFunds) {
        const e = req.payTo.toLowerCase();
        h().factory.balances.set(e, (h().factory.balances.get(e) ?? 0n) + BigInt(req.amount));
      }
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  });

  it("fallback times out but executed the authorization: 200 paid, then registered and released", async () => {
    let h: Harness;
    h = new Harness({ fallback: fallbackThat(() => h, true) });
    const q = await h.finalQuote();
    h.relayer.override = (req) => (req.kind === "fund" ? { state: "unavailable", reason: "no gas" } : undefined);
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    PaidResponseSchema.parse(await res.json());
    await h.drain();
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open); // registered by the request's follow-up
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("fallback times out and nothing moved yet: never 402 (charged 'unknown'), the claim is kept", async () => {
    let h: Harness;
    h = new Harness({ fallback: fallbackThat(() => h, false) });
    const q = await h.finalQuote();
    h.relayer.override = (req) => (req.kind === "fund" ? { state: "unavailable", reason: "no gas" } : undefined);
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ charged: "unknown" });
    expect(quoteStatus(h, q.quote_id)).toBe("settling");
  });
});

describe("L6 settlement succeeded but its detail is missing", () => {
  it("reconciles from the chain instead of answering charged:false", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    (h.s.facilitator as unknown as { take: () => undefined }).take = () => undefined;
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    const body = await res.json();
    expect(body.charged).not.toBe(false);
    expect(res.status).toBe(200);
    expect(quoteStatus(h, q.quote_id)).toBe("paid");
  });
});

describe("L7 RPC URLs and keys never reach logs, stored errors or responses (poc-rpcleak)", () => {
  const URL_WITH_KEY = "https://base-mainnet.g.alchemy.com/v2/SECRET_API_KEY_123456";
  const boom = () => {
    throw new HttpRequestError({ url: URL_WITH_KEY, status: 429, body: { method: "eth_call" } });
  };

  it("redact() strips URLs, request bodies and key-like tokens", () => {
    const e = new HttpRequestError({ url: URL_WITH_KEY, status: 429, body: { method: "eth_call", params: ["0xabc"] } });
    const out = redact(e.message);
    expect(out).not.toContain("SECRET_API_KEY");
    expect(out).toContain("base-mainnet.g.alchemy.com");
    expect(redact("key 9f8e7d6c5b4a39281706f5e4d3c2b1a0 used")).not.toContain("9f8e7d6c5b4a3928");
    expect(redact(`tx 0x${"ab".repeat(32)} reverted: invalid_exact_evm_transaction_simulation_failed`)).toContain(
      "invalid_exact_evm_transaction_simulation_failed",
    );
  });

  it("a relayer error carrying the RPC URL is stored redacted in orders.last_error", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const send = h.relayer.send.bind(h.relayer);
    h.relayer.send = async (req) => (req.kind === "release" ? boom() : send(req));
    const paid = await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json();
    await h.drain();
    const row = h.db.query<{ last_error: string | null }>(
      "SELECT last_error FROM orders WHERE id = ?",
      paid.order_id,
    )[0];
    expect(row?.last_error).toBeTruthy();
    expect(row?.last_error).not.toContain("SECRET_API_KEY");
  });

  function breakChain(h: Harness) {
    const orig = h.chain.x402Signer.bind(h.chain);
    h.chain.x402Signer = (a) => ({ ...orig(a), readContract: boom as never, verifyTypedData: boom as never });
  }
  const decode = (r: Response) => Buffer.from(r.headers.get("payment-required") ?? "", "base64").toString() || "";

  it("v2 402 after an RPC failure does not echo the URL", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    breakChain(h);
    const res = await h.pay(q.quote_id, headers);
    expect(`${decode(res)} ${await res.text()}`.includes("SECRET_API_KEY")).toBe(false);
  });

  it("v1 402 after an RPC failure does not echo the URL", async () => {
    const h = new Harness({ env: { X402_WIRE: "v1" } });
    const q = await h.finalQuote();
    const challenge = await h.request(`/v1/orders/${q.quote_id}`, { method: "POST" });
    const client = new x402Client();
    client.registerV1("base", new ExactEvmSchemeV1(h.buyer));
    client.setSpendControls(false);
    const http = new x402HTTPClient(client);
    const required = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json());
    const headers = http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
    breakChain(h);
    const res = await h.pay(q.quote_id, headers);
    expect((await res.text()).includes("SECRET_API_KEY")).toBe(false);
  });
});
