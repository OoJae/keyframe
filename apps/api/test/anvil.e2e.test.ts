import {
  CLONE_SUFFIX,
  deriveKChain,
  keyframeFactoryAbi,
  Status,
  termsFromJson,
  USDC,
  vaultImplOf,
} from "@keyframe/protocol";
import { concat, createWalletClient, erc20Abi, type Hex, hexToBytes, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keeperTick } from "../src/keeper.js";
import { anvilAvailable, chainHarness, type LocalChain, startLocalChain } from "./support/anvil.js";

// Real-chain end-to-end on a throwaway local anvil (chain id 8453, no fork, no network): the real escrow factory
// (built from contracts/src), the USDC mock at the canonical Base USDC address, the real RelayerCore signing with a
// hot key, real viem reads and the real x402 exact verifier simulating the transfer. Skips without Foundry
// (or with KEYFRAME_E2E=0).

describe.runIf(anvilAvailable())("anvil end-to-end (real factory, real relayer)", () => {
  let c: LocalChain;
  beforeAll(async () => {
    c = await startLocalChain();
  }, 120_000);
  afterAll(() => c?.stop());

  const orderOf = (termsHash: Hex) =>
    c.pub.readContract({ address: c.factory, abi: keyframeFactoryAbi, functionName: "order", args: [termsHash] });

  it("Instant: 402 → x402 payment → fundWithAuthorization → release, all on-chain", async () => {
    const { h, buyer } = await chainHarness(c);
    const operator = privateKeyToAccount(c.operatorKey).address;
    const q = await h.finalQuote();
    const t = termsFromJson(q.terms);
    expect(t.token).toBe(USDC);

    // cross-language parity with the deployed contract
    const tuple = { ...t, dueAt: BigInt(t.dueAt), deadline: BigInt(t.deadline) };
    const fac = { address: c.factory, abi: keyframeFactoryAbi } as const;
    expect(await c.pub.readContract({ ...fac, functionName: "hashTerms", args: [tuple] })).toBe(q.terms_hash);
    expect(await c.pub.readContract({ ...fac, functionName: "escrowOf", args: [q.terms_hash] })).toBe(q.escrow);
    expect(await c.pub.readContract({ ...fac, functionName: "VAULT_IMPL" })).toBe(vaultImplOf(c.factory));
    expect(await c.pub.readContract({ ...fac, functionName: "SELLER" })).toBe(c.seller);
    expect(await c.pub.getCode({ address: q.escrow })).toBeUndefined();

    const headers = await h.paymentHeaders(q.quote_id);
    const nonceBefore = await c.pub.getTransactionCount({ address: operator });
    const t0 = Date.now();
    const res = await h.pay(q.quote_id, headers);
    const elapsed = Date.now() - t0;
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.funding).toBe("confirmed");
    expect(elapsed).toBeLessThan(2_000);
    const receipt = await c.pub.getTransactionReceipt({ hash: body.funding_tx });
    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(c.factory.toLowerCase());

    await h.drain();
    const view = await orderOf(q.terms_hash);
    expect(view.status).toBe(Status.Released);
    expect(view.key).toBe(await deriveKChain(hexToBytes(h.kmasterHex), q.quote_id));
    expect(view.manifestHash).toBe(q.content.manifest_hash);
    expect(view.toSeller).toBe(1_000_000n);
    expect(await c.balance(q.escrow)).toBe(0n);
    expect(await c.balance(buyer.address)).toBe(99_000_000n);
    // E is now the canonical EIP-1167 clone of VAULT_IMPL
    const runtime = concat(["0x363d3d373d3d3d363d73", vaultImplOf(c.factory), CLONE_SUFFIX]).toLowerCase();
    expect((await c.pub.getCode({ address: q.escrow }))?.toLowerCase()).toBe(runtime);

    // replay: identical bytes, no new transaction
    const sent = await c.pub.getTransactionCount({ address: operator });
    expect(sent).toBe(nonceBefore + 2); // fund + release
    const again = await h.pay(q.quote_id, headers);
    expect(await again.text()).toBe(JSON.stringify(body));
    expect(await c.pub.getTransactionCount({ address: operator })).toBe(sent);

    const st = await (await h.request(`/v1/orders/${body.order_id}`)).json();
    expect(st).toMatchObject({ status: "key_published", to_seller: "1000000", to_buyer: "0" });
    expect(h.db.query<{ status: string }>("SELECT status FROM chain_txs").map((r) => r.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
  });

  it("an unfunded payer is refused before any transaction", async () => {
    const { h } = await chainHarness(c);
    const operator = privateKeyToAccount(c.operatorKey).address;
    const q = await h.finalQuote();
    const nonce = await c.pub.getTransactionCount({ address: operator });
    const stranger = privateKeyToAccount(generatePrivateKey()); // no USDC at all
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id, stranger));
    // the x402 simulation fails first (no balance); either way nothing is sent and nothing is charged
    expect([402, 409]).toContain(res.status);
    expect(await c.pub.getTransactionCount({ address: operator })).toBe(nonce);
  });

  it("direct rail: the buyer's own USDC.transfer to E is registered and released by the keeper", async () => {
    const { h, buyer } = await chainHarness(c);
    const q = await h.finalQuote();
    await c.pub.request({ method: "anvil_setBalance" as never, params: [buyer.address, "0xDE0B6B3A7640000"] as never });
    const wallet = createWalletClient({ account: buyer, chain: c.chain, transport: http(c.rpc) });
    await c.pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [q.escrow, 1_000_000n],
      }),
    });
    const r = await keeperTick(h.s, { waitMs: 5_000 });
    expect(r.direct_opened).toBe(1);
    await h.drain();
    expect((await orderOf(q.terms_hash)).status).toBe(Status.Released);
    expect(await c.balance(buyer.address)).toBe(99_000_000n);
  });

  it("Studio: undelivered past the deadline → keeper refunds on-chain", async () => {
    const { h, buyer } = await chainHarness(c);
    const q = await h.createQuote({
      format: "studio",
      params: {
        deliverable: "studio_sting",
        brief: "A confident ten second sting for a parachute-themed DeFi safety brand.",
      },
    });
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    await h.drain();
    expect((await orderOf(q.terms_hash)).status).toBe(Status.Open);
    expect(await c.balance(buyer.address)).toBe(75_000_000n);

    const jump = q.deadline - h.nowS() + 10;
    await c.pub.request({ method: "evm_increaseTime" as never, params: [jump] as never });
    await c.pub.request({ method: "evm_mine" as never });
    h.advance(jump);
    await keeperTick(h.s, { waitMs: 5_000 });
    expect((await orderOf(q.terms_hash)).status).toBe(Status.Refunded);
    expect(await c.balance(buyer.address)).toBe(100_000_000n);
    const order = h.db.query<{ status: string; refund_tx: string }>("SELECT status, refund_tx FROM orders")[0];
    expect(order?.status).toBe("returned");
    expect(order?.refund_tx).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
