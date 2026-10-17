// keyframe_verify funding + delivery against the mock chain and file host: real KFC1 ciphertext of a real
// 1080x1920 6 s faststart MP4, real keys, 2-RPC cross-checks, tamper and budget behaviour (P9, P10).

import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { quoteTool } from "../src/tools/quote.js";
import { verifyTool } from "../src/tools/verify.js";
import { call, type Json, setup, stingInput } from "./harness/inproc.js";
import { BUYER, CONTROL_URLS, FACTORY, HOSTILE_URLS, HOSTS, MP4, type World } from "./harness/world.js";

async function paidOrder(world: World, extra: Record<string, unknown> = {}) {
  const rec = await world.createQuote(
    quoteTool.inputSchema.parse(stingInput(BUYER.address, extra)) as Record<string, unknown>,
  );
  const tx = world.pay(rec.quote.quote_id as string);
  return { rec, tx, paid: world.paidBody(rec.quote.quote_id as string, tx) };
}

const byId = (s: Record<string, Json>, id: string) => s.checks.find((c: Json) => c.id === id);

describe("keyframe_verify funding", () => {
  it("verifies a sealed x402 payment from the paid response (wrapped like get_request)", async () => {
    const world = setup();
    const { rec, tx, paid } = await paidOrder(world);
    const r = await call(verifyTool, {
      mode: "funding",
      paid_response: { status: "success", response: { status: 200, body: JSON.stringify(paid) } },
    });
    const s = r.structuredContent as Record<string, Json>;
    expect(s.verdict, r.text).toBe("verified");
    expect(s.envelope).toBe("SEALED");
    expect(s.terms_source).toBe("api");
    expect(s.escrow).toBe(rec.escrow);
    for (const id of [
      "factory_allowlisted",
      "terms_hash",
      "escrow_address",
      "base_rpcs",
      "escrow_code",
      "registered_deal",
      "funded",
      "funding_tx",
    ]) {
      expect(byId(s, id)?.status, id).toBe("pass");
    }
    expect(byId(s, "funding_tx").detail).toContain(tx.slice(0, 10));
    expect(r.text).toContain("Next: keyframe_status");
  });

  it("verifies a direct-rail payment from quote_id + tx_hash before registration", async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    const tx = world.pay(rec.quote.quote_id as string, { register: false });
    rec.quote.status = "final";
    const s = (await call(verifyTool, { mode: "funding", quote_id: rec.quote.quote_id, tx_hash: tx }))
      .structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("verified");
    expect(byId(s, "funded").detail).toMatch(/registration pending/);
    expect(s.envelope).toBe("SEALED");
  });

  it("reports NOT SEALED and fails when nothing was paid", async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    const s = (await call(verifyTool, { mode: "funding", quote_id: rec.quote.quote_id })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("failed");
    expect(s.envelope).toBe("NOT SEALED");
    expect(byId(s, "funded").status).toBe("fail");
  });

  it('is partial (not failed) while the paid response\'s funding tx is not mined yet (funding "pending")', async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    const qid = rec.quote.quote_id as string;
    rec.quote.status = "paid";
    const tx = keccak256(toHex(`pending:${qid}`));
    const paid = { ...world.paidBody(qid, tx), funding: "pending" };
    let s = (await call(verifyTool, { mode: "funding", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("partial");
    expect(s.envelope).toBe("NOT SEALED");
    expect(byId(s, "funded")).toMatchObject({ status: "skip" });
    expect(byId(s, "funded").detail).toMatch(/not sealed yet/);
    expect(byId(s, "funding_tx").status).toBe("skip");
    // Once that transaction is mined without moving the money, it is a failure again.
    world.receipts.set(tx, { status: "0x1", to: FACTORY, logs: [] });
    s = (await call(verifyTool, { mode: "funding", paid_response: paid })).structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("failed");
    expect(byId(s, "funded").status).toBe("fail");
    expect(byId(s, "funding_tx").status).toBe("fail");
  });

  it("is only partial when one RPC is down, and flags RPCs that disagree", async () => {
    const world = setup();
    const { paid, rec } = await paidOrder(world);
    world.down.add("rpc2.kf.test");
    let s = (await call(verifyTool, { mode: "funding", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("partial");
    expect(byId(s, "base_rpcs").status).toBe("skip");
    world.down.clear();
    world.hooks.rpc = (host, method, params, result) =>
      host === "rpc2.kf.test" &&
      method === "eth_call" &&
      String((params[0] as { data: string }).data).startsWith("0x70a08231")
        ? `0x${"0".repeat(64)}`
        : result;
    s = (await call(verifyTool, { mode: "funding", terms: rec.quote.terms, factory: rec.quote.factory }))
      .structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("partial");
    expect(byId(s, "base_rpcs").detail).toMatch(/DISAGREE/);
  });

  it("works from terms alone with no API at all (chain-only proof)", async () => {
    const world = setup();
    const { rec } = await paidOrder(world);
    world.down.add("api.kf.test");
    const s = (await call(verifyTool, { mode: "funding", terms: rec.quote.terms, factory: rec.quote.factory }))
      .structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("verified");
    expect(s.terms_source).toBe("argument");
  });

  it("refuses a paid response whose escrow is not derived from an allowlisted factory", async () => {
    const world = setup();
    const { paid } = await paidOrder(world);
    const r = await call(verifyTool, {
      mode: "funding",
      paid_response: { ...paid, escrow: "0x000000000000000000000000000000000000dEaD" },
    });
    const s = r.structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("failed");
    expect(byId(s, "escrow_address").status).toBe("fail");
  });
});

describe("keyframe_verify delivery", () => {
  it("decrypts and checks every chunk, the fingerprint and the MP4 header (public order)", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    const r = await call(verifyTool, { mode: "delivery", paid_response: paid });
    const s = r.structuredContent as Record<string, Json>;
    expect(s.verdict, r.text).toBe("verified");
    expect(s.envelope).toBe("KEY PUBLISHED");
    expect(s.delivery).toMatchObject({
      chunks_total: 3,
      chunks_verified: 3,
      bytes_total: rec.plaintext.byteLength,
      media: { width: 1080, height: 1920, duration_ms: 6000 },
    });
    for (const id of [
      "key_published",
      "key_matches_deal",
      "file_matches_deal",
      "manifest",
      "decrypts",
      "file_fingerprint",
      "video_header",
      "matches_brief",
    ]) {
      expect(byId(s, id)?.status, id).toBe("pass");
    }
    expect(MP4.byteLength).toBeLessThan(rec.plaintext.byteLength);
  });

  it("private order: needs k_buyer, checks it against the brief, then verifies", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world, { delivery: "private" });
    world.release(rec.quote.quote_id as string);
    const without = { ...paid, k_buyer: null };
    let s = (await call(verifyTool, { mode: "delivery", paid_response: without })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("failed");
    expect(byId(s, "k_buyer").detail).toMatch(/private order/);
    s = (await call(verifyTool, { mode: "delivery", paid_response: without, k_buyer: `0x${"42".repeat(32)}` }))
      .structuredContent as Record<string, Json>;
    expect(byId(s, "k_buyer").status).toBe("fail");
    s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("verified");
    expect(byId(s, "k_buyer").status).toBe("pass");
  });

  it("fails closed on a 1-bit tamper of any chunk", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    const path = `/c/${rec.manifestHash}/1.bin`;
    const tampered = Uint8Array.from(world.files.get(path) as Uint8Array);
    tampered[1000] = (tampered[1000] as number) ^ 1;
    world.files.set(path, tampered);
    const s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("failed");
    expect(byId(s, "chunk_hashes").detail).toMatch(/chunk 1 does not match/);
  });

  it("fails when the manifest or the on-chain key is wrong", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string, { key: `0x${"07".repeat(32)}` });
    let s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(byId(s, "key_matches_deal").status).toBe("fail");
    expect(s.verdict).toBe("failed");

    world.release(rec.quote.quote_id as string);
    world.files.set(`/c/${rec.manifestHash}/manifest.json`, new TextEncoder().encode('{"v":1}'));
    s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<string, Json>;
    expect(byId(s, "manifest").status).toBe("fail");
  });

  it("released with a different file than was paid for: file_matches_deal fails", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string, { manifestHash: `0x${"ab".repeat(32)}` });
    const s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(byId(s, "file_matches_deal").status).toBe("fail");
  });

  it("max_chunks samples first + last and reports partial", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    const s = (await call(verifyTool, { mode: "delivery", paid_response: paid, max_chunks: 2 }))
      .structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("partial");
    expect(s.delivery.chunks_verified).toBe(2);
    expect(byId(s, "file_fingerprint").status).toBe("skip");
    expect(byId(s, "video_header").status).toBe("pass");
  });

  it("not delivered yet: skip with the envelope state", async () => {
    const world = setup();
    const { paid } = await paidOrder(world);
    const s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("partial");
    expect(byId(s, "key_published").detail).toMatch(/not delivered yet: SEALED/);
  });

  it("falls back to the IPFS mirror when the file host is down (hashes still decide)", async () => {
    const world = setup({ KEYFRAME_IPFS_GATEWAY: "https://ipfs.kf.test" });
    world.ipfs = true;
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    world.down.add("files.kf.test");
    const s = (await call(verifyTool, { mode: "delivery", paid_response: paid })).structuredContent as Record<
      string,
      Json
    >;
    expect(s.verdict).toBe("verified");
    expect(s.delivery.chunks_verified).toBe(3);
    expect(world.log.some((l) => l.url.startsWith("https://ipfs.kf.test/ipfs/b"))).toBe(true);
  });

  it("stays within the tool budget when the file host is slow", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    world.delays.set("files.kf.test", 5_000);
    const r = await call(verifyTool, { mode: "delivery", paid_response: paid });
    const s = r.structuredContent as Record<string, Json>;
    expect(r.ms).toBeLessThan(8_500);
    expect(s.verdict).toBe("partial");
    expect(byId(s, "manifest").status).toBe("skip");
  });
});

describe("keyframe_verify delivery: Keyframe's watch link (F02)", () => {
  const FALLBACK = "keyframe_status shows Keyframe's watch link when one is available.";

  it("shows Watch & download from the paid response's watch_url", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    const url = `${HOSTS.api}/w/${rec.orderId}`;
    const r = await call(verifyTool, { mode: "delivery", paid_response: { ...paid, watch_url: url } });
    expect((r.structuredContent as Record<string, Json>).verdict, r.text).toBe("verified");
    const lines = r.text.split("\n");
    const at = lines.indexOf(`Watch & download: ${JSON.stringify(url)}`);
    expect(lines[at - 1]).toMatch(/^Encrypted copy: .*without Keyframe's server\.$/);
    expect(r.text).not.toContain(FALLBACK);
    expect(r.text).not.toContain("download link is in keyframe_status");
  });

  it("shows Watch & download from the order record (order_id), links[] kind watch included", async () => {
    const world = setup();
    const { rec } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    world.orderExtra = { links: [{ kind: "watch", url: `${HOSTS.files}/w/${rec.orderId}` }] };
    const r = await call(verifyTool, { mode: "delivery", order_id: rec.orderId });
    expect(r.text).toContain(`Watch & download: "${HOSTS.files}/w/${rec.orderId}"`);
    expect(r.text).not.toContain(FALLBACK);
  });

  it("without a valid watch link: the fallback sentence, and nothing from a foreign host", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    world.release(rec.quote.quote_id as string);
    let r = await call(verifyTool, { mode: "delivery", paid_response: paid });
    expect(r.text).toContain(
      `(chunks alongside). The key is public on Base, so this file stays openable even without Keyframe's server. ${FALLBACK}`,
    );
    expect(r.text).not.toContain("Watch & download");
    for (const url of [...HOSTILE_URLS.slice(0, 5), ...CONTROL_URLS]) {
      r = await call(verifyTool, { mode: "delivery", paid_response: { ...paid, watch_url: url } });
      expect(r.text, url).toContain(FALLBACK);
      expect(r.text).not.toMatch(/Watch & download|evil\.example|javascript:|data:text|IMPORTANT/);
    }
  });

  it("not delivered yet: no watch line and no fallback sentence", async () => {
    const world = setup();
    const { rec, paid } = await paidOrder(world);
    const r = await call(verifyTool, {
      mode: "delivery",
      paid_response: { ...paid, watch_url: `${HOSTS.api}/w/${rec.orderId}` },
    });
    expect(r.text).not.toMatch(/Watch & download|watch link/);
  });
});
