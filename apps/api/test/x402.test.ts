import { buildPaymentRequiredV1, buildPaymentRequiredV2, parsePaymentRequired, USDC } from "@keyframe/protocol";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { QuoteRow } from "../src/db/rows.js";
import { Harness, PUBLIC_BASE } from "./support/harness.js";

// Frozen §7: the unpaid 402 is byte-identical per quote, for any method and any request headers, and never
// carries both wire versions. A draft quote never serves a 402.

const QID = "q_7Q2M7Q2M7Q2M7Q2M7Q2M7Q";
const ESCROW = getAddress("0xe5c1b0af2b6e53c0ae3e4d8b1a0f2c9d8e7a9a3f");

function fixedQuote(h: Harness): QuoteRow {
  const now = h.nowS();
  return {
    id: QID,
    status: "final",
    tier: "instant",
    format: "launch_sting",
    catalog_id: "launch_sting",
    buyer: h.buyer.address,
    buyer_lc: h.buyer.address.toLowerCase(),
    amount: "4000000",
    delivery: "public",
    hero_ms: 3400,
    spec_json: JSON.stringify({ durationS: 6, aspect: "9:16" }),
    spec_hash: `0x${"11".repeat(32)}`,
    terms_json: "{}",
    terms_hash: `0x${"22".repeat(32)}`,
    escrow: ESCROW,
    data_snapshot: null,
    still_url: null,
    still_sha256: null,
    preview_url: null,
    manifest_hash: `0x${"33".repeat(32)}`,
    eta_s: 15,
    quote_expires_at: now + 600,
    deadline: 1792333920, // 2026-10-18 14:32 UTC
    pay_from: null,
    pay_nonce: null,
    order_id: null,
    cancel_reason: null,
    created_at: now,
    finalized_at: now,
    updated_at: now,
  };
}

describe("unpaid 402 (v2 default)", () => {
  it("is the exact frozen §7 shape, byte-identical to @keyframe/protocol's builder", async () => {
    const h = new Harness();
    await h.repo.createQuote(fixedQuote(h), null);
    const res = await h.request(`/v1/orders/${QID}`, { method: "POST" });
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("{}");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();

    const description = `Keyframe order ${QID}: Launch Sting 6s 9:16. Pay-on-delivery escrow ${ESCROW.slice(0, 6)}…${ESCROW.slice(-4)}; refundable to the buyer after 2026-10-18 14:32 UTC.`;
    const expected =
      `{"x402Version":2,"error":"Payment required","resource":{"url":"${PUBLIC_BASE}/v1/orders/${QID}",` +
      `"description":"${description}","mimeType":"application/json"},"accepts":[{"scheme":"exact",` +
      `"network":"eip155:8453","amount":"4000000","asset":"${USDC}","payTo":"${ESCROW}",` +
      `"maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}]}`;
    expect(Buffer.from(header ?? "", "base64").toString("utf8")).toBe(expected);
    expect(header).toBe(Buffer.from(expected, "utf8").toString("base64"));
    const proto = buildPaymentRequiredV2({
      url: `${PUBLIC_BASE}/v1/orders/${QID}`,
      description,
      amount: 4_000_000n,
      payTo: ESCROW,
    });
    expect(header).toBe(proto.headers["PAYMENT-REQUIRED"]);

    // The plugin's parser accepts it as a single-version v2 402.
    const parsed = parsePaymentRequired({ status: 402, headers: res.headers, bodyText: "{}" });
    expect(parsed.version).toBe(2);
    expect(parsed.accepts).toHaveLength(1);
  });

  it("is identical across methods, headers, Accept: text/html and browser user agents", async () => {
    const h = new Harness();
    await h.repo.createQuote(fixedQuote(h), null);
    const variants: RequestInit[] = [
      { method: "POST" },
      { method: "GET" },
      { method: "PUT", body: "anything" },
      { method: "DELETE" },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote_id: QID }) },
      { method: "GET", headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Macintosh)" } },
      {
        method: "GET",
        headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", host: "evil.example" },
      },
      { method: "POST", headers: { "payment-signature": "not-base64!!" } },
    ];
    const seen = new Set<string>();
    for (const init of variants) {
      const res = await h.request(`/v1/orders/${QID}?utm=1`, init);
      expect(res.status).toBe(402);
      expect(await res.text()).toBe("{}");
      seen.add(
        `${res.headers.get("payment-required")}|${res.headers.get("content-type")}|${res.headers.get("cache-control")}`,
      );
    }
    expect(seen.size).toBe(1);
  });

  it("v1 wire: JSON body only (no header), byte-identical to the protocol builder", async () => {
    const h = new Harness({ env: { X402_WIRE: "v1" } });
    await h.repo.createQuote(fixedQuote(h), null);
    const a = await h.request(`/v1/orders/${QID}`, { method: "POST" });
    const b = await h.request(`/v1/orders/${QID}`, { method: "GET", headers: { accept: "text/html" } });
    expect(a.status).toBe(402);
    expect(a.headers.get("payment-required")).toBeNull();
    const body = await a.text();
    expect(await b.text()).toBe(body);
    const description = JSON.parse(body).accepts[0].description;
    const proto = buildPaymentRequiredV1({
      url: `${PUBLIC_BASE}/v1/orders/${QID}`,
      description,
      amount: "4000000",
      payTo: ESCROW,
    });
    expect(body).toBe(proto.body);
    const parsed = parsePaymentRequired({ status: 402, headers: a.headers, bodyText: body });
    expect(parsed.version).toBe(1);
  });
});

describe("quotes that cannot be paid never serve a 402", () => {
  it("draft: 425 not-ready JSON for every method, with or without a payment header", async () => {
    const h = new Harness();
    const q = await h.createQuote();
    expect(q.status).toBe("draft");
    for (const init of [
      { method: "GET" },
      { method: "POST" },
      { method: "POST", headers: { "payment-signature": "eyJ4IjoxfQ==" } },
    ]) {
      const res = await h.request(`/v1/orders/${q.quote_id}`, init);
      expect(res.status).toBe(425);
      expect(res.headers.get("payment-required")).toBeNull();
      expect(res.headers.get("retry-after")).toBe("3");
      const body = await res.json();
      expect(body).toMatchObject({ error: "quote_not_ready", status: "draft", charged: false });
    }
  });

  it("expired → 410, cancelled → 410, unknown → 404", async () => {
    const h = new Harness();
    const row = fixedQuote(h);
    await h.repo.createQuote(row, null);
    h.advance(601);
    const expired = await h.request(`/v1/orders/${QID}`);
    expect(expired.status).toBe(410);
    expect(expired.headers.get("payment-required")).toBeNull();
    expect((await expired.json()).error).toBe("quote_expired");

    const h2 = new Harness();
    await h2.repo.createQuote({ ...fixedQuote(h2), status: "cancelled", cancel_reason: "render_failed" }, null);
    const cancelled = await h2.request(`/v1/orders/${QID}`);
    expect(cancelled.status).toBe(410);
    expect((await h2.request("/v1/orders/q_1111111111111111111111")).status).toBe(404);
  });

  it("maintenance mode → 503 without a 402", async () => {
    const h = new Harness({ env: { MAINTENANCE: "1" } });
    await h.repo.createQuote(fixedQuote(h), null);
    const res = await h.request(`/v1/orders/${QID}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("payment-required")).toBeNull();
  });
});
