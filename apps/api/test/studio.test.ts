import { decisionTypedData, keyframeFactoryAbi, payoutAt, Status, termsFromJson } from "@keyframe/protocol";
import { decodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { keeperTick } from "../src/keeper.js";
import { changeRequestTypedData } from "../src/reviews.js";
import { fixture, Harness, type Json, WORKER_ID } from "./support/harness.js";

// Studio tier: pay → deliver (manifest bound on-chain) → buyer review via EIP-712 Decision → release / refund.

const BRIEF = "A confident ten second sting for a parachute-themed DeFi safety brand, calm and precise.";

async function paidStudioOrder(h: Harness) {
  const q = await h.createQuote({ format: "studio", params: { deliverable: "studio_sting", brief: BRIEF } });
  const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
  expect(res.status).toBe(200);
  const paid = await res.json();
  await h.drain();
  return { q, paid };
}

async function deliver(h: Harness, orderId: string) {
  const open = await h.internal(`/studio/orders/${orderId}/delivery`, { method: "POST" });
  expect(open.status).toBe(200);
  const job = await open.json();
  expect(job.kind).toBe("studio_delivery");
  expect(job.template).toBeNull();
  const mp4 = fixture("studio-10s-9x16.m4v");
  const put = async (path: string, body: BodyInit, type: string) => {
    const r = await h.internal(path, { method: "PUT", headers: { "content-type": type }, body });
    expect(r.status, `${path}: ${await r.clone().text()}`).toBe(200);
  };
  await put(job.upload.preview, mp4 as Uint8Array<ArrayBuffer>, "video/mp4");
  const { encryptWithRawKey } = await import("./support/harness.js");
  const enc = await encryptWithRawKey(mp4, job.kfc1.k_file, job.kfc1.salt, {
    mime: "video/mp4",
    width: 1080,
    height: 1920,
    durationMs: 10_000,
    fps: 30,
  });
  await put(job.upload.manifest, JSON.stringify(enc.manifest), "application/json");
  await put(job.upload.chunk.replace("{i}", "0"), enc.chunks[0] as Uint8Array<ArrayBuffer>, "application/octet-stream");
  const done = await h.internal(`/jobs/${job.job_id}/done`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(done.status, await done.clone().text()).toBe(200);
  return (await done.json()) as Json;
}

describe("Studio", () => {
  it("deliver → accept by signature → release at payoutAt(deliveredAt)", async () => {
    const h = new Harness();
    const { q, paid } = await paidStudioOrder(h);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open);
    // Instant-only release must not fire for a Studio order
    expect(h.relayer.count("release")).toBe(0);

    const delivered = await deliver(h, paid.order_id);
    expect(delivered.state).toBe("confirmed");
    const dcall = decodeFunctionData({
      abi: keyframeFactoryAbi,
      data: h.relayer.sends.find((r) => r.kind === "deliver")?.data as Hex,
    });
    expect(dcall.functionName).toBe("deliver");
    expect(dcall.args[1]).toBe(delivered.manifest_hash);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Delivered);
    const status = await (await h.request(`/v1/orders/${paid.order_id}?token=${paid.access_token}`)).json();
    expect(status.status).toBe("delivered");
    expect(status.review_ends_at).toBe(h.nowS() + 86_400);
    expect(status.preview_url).toMatch(/\/files\/p\/q_/);

    // challenge → typed data for request_wallet_sign
    const ch = await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, {
      access_token: paid.access_token,
      decision: "accept",
    });
    expect(ch.status).toBe(200);
    const challenge = await ch.json();
    expect(challenge.typed_data.primaryType).toBe("Decision");
    expect(challenge.typed_data.domain).toEqual({
      name: "Keyframe Escrow",
      version: "1",
      chainId: 8453,
      verifyingContract: h.s.cfg.factory,
    });
    expect(challenge.typed_data.message).toEqual({
      termsHash: q.terms_hash,
      accept: true,
      deadline: String(challenge.sig_deadline),
    });

    // the buyer signs exactly that typed data (as request_wallet_sign would)
    const td = decisionTypedData(q.terms_hash, true, challenge.sig_deadline, h.s.cfg.factory);
    const signature = await h.buyer.signTypedData(td);

    // a stranger's signature is refused and never relayed
    const stranger = privateKeyToAccount(generatePrivateKey());
    const bad = await h.postJson(`/v1/reviews/${paid.order_id}/submit`, {
      access_token: paid.access_token,
      decision: "accept",
      signature: await stranger.signTypedData(td),
      sig_deadline: challenge.sig_deadline,
    });
    expect(bad.status).toBe(401);
    expect(h.relayer.count("decide")).toBe(0);

    const ok = await h.postJson(`/v1/reviews/${paid.order_id}/submit`, {
      access_token: paid.access_token,
      decision: "accept",
      signature,
      sig_deadline: challenge.sig_deadline,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toBe("confirmed");
    const dec = decodeFunctionData({
      abi: keyframeFactoryAbi,
      data: h.relayer.sends.find((r) => r.kind === "decide")?.data as Hex,
    });
    expect(dec.functionName).toBe("decideBySig");
    expect(dec.args.slice(1)).toEqual([true, BigInt(challenge.sig_deadline), signature]);

    await h.drain();
    const rel = h.relayer.sends.filter((r) => r.kind === "release");
    expect(rel).toHaveLength(1);
    const r = decodeFunctionData({ abi: keyframeFactoryAbi, data: rel[0]?.data as Hex });
    const t = termsFromJson(q.terms);
    expect(r.args[2]).toBe(payoutAt(t, h.factory.view(q.terms_hash).deliveredAt));
    expect(r.args[3]).toBe(delivered.manifest_hash);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("silence counts as accept: the keeper releases after the review window", async () => {
    const h = new Harness();
    const { q, paid } = await paidStudioOrder(h);
    await deliver(h, paid.order_id);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Delivered);
    h.advance(86_400);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("reject by signature returns the money; one 'changes' request is recorded off-chain", async () => {
    const h = new Harness();
    const { q, paid } = await paidStudioOrder(h);
    await deliver(h, paid.order_id);
    // "changes": a ChangeRequest (not a Decision) signed by the buyer, recorded off-chain
    const cc = await (
      await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, {
        access_token: paid.access_token,
        decision: "changes",
      })
    ).json();
    expect(cc.typed_data.primaryType).toBe("ChangeRequest");
    const ctd = changeRequestTypedData(q.terms_hash, cc.sig_deadline, h.s.cfg.factory);
    const submitChanges = (signature: string) =>
      h.postJson(`/v1/reviews/${paid.order_id}/submit`, {
        access_token: paid.access_token,
        decision: "changes",
        signature,
        sig_deadline: cc.sig_deadline,
      });
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await submitChanges(await stranger.signTypedData(ctd))).status).toBe(401);
    const csig = await h.buyer.signTypedData(ctd);
    expect(await (await submitChanges(csig)).json()).toMatchObject({ status: "changes_requested", tx: null });
    expect((await submitChanges(csig)).status).toBe(409);

    const ch = await (
      await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, {
        access_token: paid.access_token,
        decision: "reject",
      })
    ).json();
    const signature = await h.buyer.signTypedData(
      decisionTypedData(q.terms_hash, false, ch.sig_deadline, h.s.cfg.factory),
    );
    const res = await h.postJson(`/v1/reviews/${paid.order_id}/submit`, {
      access_token: paid.access_token,
      decision: "reject",
      signature,
      sig_deadline: ch.sig_deadline,
    });
    expect(res.status).toBe(200);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Rejected);
    const st = await (await h.request(`/v1/orders/${paid.order_id}`)).json();
    expect(st.status).toBe("returned");
    expect(st.to_buyer).toBe("25000000");
  });

  it("undelivered by the deadline → keeper refunds; studio decline → cancel", async () => {
    const h = new Harness();
    const { q } = await paidStudioOrder(h);
    h.advance(48 * 3600 + 601);
    await keeperTick(h.s, { waitMs: 0 });
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Refunded);

    const h2 = new Harness();
    const { q: q2, paid } = await paidStudioOrder(h2);
    const c = await h2.internal(`/studio/orders/${paid.order_id}/cancel`, { method: "POST" });
    expect(c.status).toBe(200);
    expect(h2.factory.view(q2.terms_hash).status).toBe(Status.Cancelled);
    expect((await (await h2.request(`/v1/orders/${paid.order_id}`)).json()).status).toBe("void");
    expect(WORKER_ID).toBe("worker-1");
  });

  it("review endpoints require the order's access token", async () => {
    const h = new Harness();
    const { paid } = await paidStudioOrder(h);
    const res = await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, {
      access_token: "x".repeat(43),
      decision: "accept",
    });
    expect(res.status).toBe(401);
    const early = await h.postJson(`/v1/reviews/${paid.order_id}/challenge`, {
      access_token: paid.access_token,
      decision: "accept",
    });
    expect(early.status).toBe(409);
  });
});
