import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import { checkAccessToken } from "../src/orders/access.js";
import { Harness } from "./support/harness.js";

// New-chat recovery: EIP-4361 challenge/verify returns the buyer's orders with fresh access tokens and k_buyer.

async function paidOrder(h: Harness, delivery: "public" | "private") {
  const q = await h.finalQuote({ delivery });
  const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
  await h.drain();
  return res.json();
}

describe("SIWE recovery", () => {
  it("challenge → sign → verify returns orders with valid access tokens and k_buyer", async () => {
    const h = new Harness();
    const paid = await paidOrder(h, "private");
    const ch = await (await h.postJson("/v1/auth/siwe/challenge", { address: h.buyer.address.toLowerCase() })).json();
    expect(ch.message).toContain("api.keyframe.test wants you to sign in with your Ethereum account:");
    expect(ch.message).toContain(h.buyer.address);
    expect(ch.message).toContain("Chain ID: 8453");
    const signature = await h.buyer.signMessage({ message: ch.message });
    const res = await h.postJson("/v1/auth/siwe/verify", { address: h.buyer.address, message: ch.message, signature });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      order_id: paid.order_id,
      k_buyer: paid.k_buyer,
      access_token: paid.access_token,
    });
    expect(
      await checkAccessToken(h.s.cfg.secrets.accessSecret as Uint8Array, paid.order_id, body.orders[0].access_token),
    ).toBe(true);

    // single use
    const again = await h.postJson("/v1/auth/siwe/verify", {
      address: h.buyer.address,
      message: ch.message,
      signature,
    });
    expect(again.status).toBe(401);
  });

  it("rejects a signature from another wallet, a forged message, a foreign domain and an expired challenge", async () => {
    const h = new Harness();
    const other = privateKeyToAccount(generatePrivateKey());
    const ch = await (await h.postJson("/v1/auth/siwe/challenge", { address: h.buyer.address })).json();
    const wrongSigner = await other.signMessage({ message: ch.message });
    expect(
      (
        await h.postJson("/v1/auth/siwe/verify", {
          address: h.buyer.address,
          message: ch.message,
          signature: wrongSigner,
        })
      ).status,
    ).toBe(401);

    // a message we never issued (same shape, attacker-chosen nonce)
    const forged = createSiweMessage({
      address: h.buyer.address,
      chainId: 8453,
      domain: "api.keyframe.test",
      uri: "https://api.keyframe.test",
      version: "1",
      nonce: "attackerNonce123",
      issuedAt: new Date(h.nowMs),
      expirationTime: new Date(h.nowMs + 600_000),
    });
    const sig1 = await h.buyer.signMessage({ message: forged });
    expect(
      (await h.postJson("/v1/auth/siwe/verify", { address: h.buyer.address, message: forged, signature: sig1 })).status,
    ).toBe(401);

    const foreign = createSiweMessage({
      address: h.buyer.address,
      chainId: 8453,
      domain: "evil.example",
      uri: "https://evil.example",
      version: "1",
      nonce: ch.nonce,
    });
    const sig2 = await h.buyer.signMessage({ message: foreign });
    expect(
      (await h.postJson("/v1/auth/siwe/verify", { address: h.buyer.address, message: foreign, signature: sig2 }))
        .status,
    ).toBe(401);

    const sig3 = await h.buyer.signMessage({ message: ch.message });
    h.advance(601);
    expect(
      (await h.postJson("/v1/auth/siwe/verify", { address: h.buyer.address, message: ch.message, signature: sig3 }))
        .status,
    ).toBe(401);
  });

  it("public list exposes only ids, statuses and the (secret-free) watch link", async () => {
    const h = new Harness();
    const paid = await paidOrder(h, "public");
    const list = await (await h.request(`/v1/orders?buyer=${h.buyer.address}`)).json();
    const watch = `https://api.keyframe.test/w/${paid.order_id}`;
    expect(list.orders).toEqual([
      {
        order_id: paid.order_id,
        status: "key_published",
        tier: "instant",
        created_at: expect.any(Number),
        watch_url: watch,
        links: [{ kind: "watch", url: watch }],
      },
    ]);
    expect((await h.request("/v1/orders?buyer=nope")).status).toBe(400);
  });
});
