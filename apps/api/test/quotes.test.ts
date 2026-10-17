import {
  deriveKBuyer,
  deriveKChain,
  encryptKfc1,
  escrowOf,
  hashTerms,
  keyHashOf,
  QuoteSchema,
  SpecSchema,
  saltOf,
  sha256Hex,
  specHash,
  termsFromJson,
  USDC,
  vaultImplOf,
  verifyManifest,
} from "@keyframe/protocol";
import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { CATALOG, catalogItem } from "../src/catalog.js";
import { rawFileKey } from "../src/delivery/keys.js";
import { TEMPLATES } from "../src/templates.js";
import { encryptWithRawKey, FACTORY, fixture, Harness, type Json, SANCTIONED, SELLER } from "./support/harness.js";

const kmasterOf = (h: Harness) => hexToBytes(h.kmasterHex);

describe("POST /v1/quotes", () => {
  it("Instant quote starts as a provisional draft that the plugin's QuoteSchema accepts", async () => {
    const h = new Harness();
    const q = await h.createQuote();
    expect(q.status).toBe("draft");
    expect(q.retry_after_ms).toBeGreaterThan(0);
    expect(q.price).toEqual({ atomic: "1000000", usdc: "1.00" });
    expect(q.tier).toBe("instant");
    expect(q.format).toBe("countdown");
    expect(q.terms.contentHash).toBe(`0x${"0".repeat(64)}`);
    expect(q.spec.keyframe).toBeNull();
    QuoteSchema.parse(q);
    // one render job queued
    expect(h.db.query("SELECT kind, status FROM jobs")).toEqual([{ kind: "instant_render", status: "queued" }]);
  });

  it("prices every catalog format per product-render-demo §A2 (and the task's countdown = 1)", () => {
    const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));
    const price = (id: string) => catalogItem(id)?.prices;
    expect(price("launch_sting")).toEqual({ 6: usdc(4), 10: usdc(7) });
    expect(price("countdown")).toEqual({ 8: usdc(1) });
    expect(price("portfolio_pulse")).toEqual({ 8: usdc(3) });
    expect(price("kinetic_post")).toEqual({ 6: usdc(3), 9: usdc(3), 12: usdc(3), 15: usdc(3) });
    expect(price("chart_moment")).toEqual({ 10: usdc(5) });
    expect(price("studio_sting")).toEqual({ 10: usdc(25) });
    expect(price("studio_spot")).toEqual({ 20: usdc(50) });
    expect(price("probe")).toEqual({ 2: usdc(0.1) });
    expect(catalogItem("probe")?.hidden).toBe(true);
  });

  it("styles, hero frames and readiness come from templates/<id>/template.json", () => {
    for (const item of CATALOG.filter((i) => i.templateId)) {
      const t = TEMPLATES[item.templateId as string];
      expect(t, item.id).toBeTruthy();
      expect([...(t?.durations ?? [])].sort(), item.id).toEqual(Object.keys(item.prices).map(Number).sort());
      expect(item.styles).toEqual(t?.styles);
      expect(item.renderable).toBe(
        (t?.status === "reference" || t?.status === "production") && (t?.styles.length ?? 0) > 0,
      );
    }
    expect(catalogItem("countdown")).toMatchObject({ renderable: true, styles: ["tminus"], heroMs: { 8: 3000 } });
    expect(catalogItem("probe")).toMatchObject({ renderable: true, styles: ["probe"], heroMs: { 2: 1000 } });
  });

  it("quotes every sellable format; formats whose template awaits design answer 422", async () => {
    const h = new Harness({ env: { FORMATS_DISABLED: "" } });
    const style = (id: string) => catalogItem(id)?.styles[0] ?? "default";
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "launch_sting",
        { format: "launch_sting", params: { style: style("launch_sting"), wordmark: "Ripcord", duration_s: 10 } },
        "7000000",
      ],
      [
        "countdown",
        {
          format: "countdown",
          params: { style: "tminus", label: "Mainnet", target: new Date(Date.now() + 86_400_000).toISOString() },
        },
        "1000000",
      ],
      [
        "portfolio_pulse",
        {
          format: "portfolio_pulse",
          params: {
            style: style("portfolio_pulse"),
            as_of: new Date().toISOString(),
            holdings: [{ symbol: "ETH", usd: 1234.5, change_24h: 0.0312 }],
          },
        },
        "3000000",
      ],
      [
        "kinetic_post",
        { format: "kinetic_post", params: { style: style("kinetic_post"), text: "We ship on Friday." } },
        "3000000",
      ],
      [
        "chart_moment",
        { format: "chart_moment", params: { style: style("chart_moment"), asset: "ETH", window: "7d" } },
        "5000000",
      ],
      [
        "studio_sting",
        {
          format: "studio",
          params: {
            deliverable: "studio_sting",
            brief: "A confident ten second sting for a parachute-themed DeFi safety brand.",
          },
        },
        "25000000",
      ],
      [
        "studio_spot",
        {
          format: "studio",
          params: {
            deliverable: "studio_spot",
            brief: "A twenty second launch spot with a style frame first, calm and precise.",
          },
        },
        "50000000",
      ],
      ["probe", { format: "catalog", params: { catalog_id: "probe", values: {} } }, "100000"],
    ];
    for (const [id, body, atomic] of cases) {
      const res = await h.postJson("/v1/quotes", h.quoteBody(body));
      if (catalogItem(id)?.renderable) {
        expect(res.status, `${id}: ${await res.clone().text()}`).toBe(201);
        const q = await res.json();
        expect(q.price.atomic, id).toBe(atomic);
        QuoteSchema.parse(q);
      } else {
        expect(res.status, id).toBe(422);
        const e = await res.json();
        expect(e.error).toBe("format_unavailable");
        expect(e.message).toContain("available now: countdown");
      }
    }
  });

  it("Studio quotes are final immediately with a review window and contentHash 0", async () => {
    const h = new Harness();
    const q = await h.createQuote({
      format: "studio",
      params: {
        deliverable: "studio_sting",
        brief: "A confident ten second sting for a parachute-themed DeFi safety brand.",
      },
    });
    expect(q.status).toBe("final");
    expect(q.tier).toBe("studio");
    expect(q.format).toBe("studio_sting");
    expect(q.terms.reviewWindow).toBe(86_400);
    expect(q.terms.contentHash).toBe(`0x${"0".repeat(64)}`);
    expect(q.deadline - q.quote_expires_at).toBe(48 * 3600);
    expect(h.db.query("SELECT * FROM jobs")).toHaveLength(0);
  });

  it("rejects invalid requests, policy violations, sanctioned buyers and unavailable formats", async () => {
    const h = new Harness();
    const target = new Date(h.nowMs + 86_400_000).toISOString();
    const cd = (p: Record<string, unknown>) => ({
      format: "countdown",
      params: { style: "tminus", label: "Mainnet", target, ...p },
    });
    const sting = (p: Record<string, unknown>) => ({
      format: "launch_sting",
      params: { style: "any", wordmark: "Ok", ...p },
    });
    const status = async (over: Record<string, unknown>) => (await h.postJson("/v1/quotes", h.quoteBody(over))).status;
    // schema (strict per-format params; https-only URLs)
    expect(await status({ rights_confirmed: undefined })).toBe(400);
    expect(await status(cd({ label: "x".repeat(33) }))).toBe(400);
    expect(await status(cd({ extra: 1 }))).toBe(400);
    expect(await status(sting({ logo_url: "http://x.example/logo.png" }))).toBe(400);
    expect(await status(cd({ style: "nope" }))).toBe(400);
    // content policy runs before availability
    expect(await status(sting({ logo_url: "https://127.0.0.1/logo.png" }))).toBe(422);
    expect(await status(cd({ label: "nsfw drop" }))).toBe(422);
    expect(await status(cd({ cta: "visit www.scam.io/x" }))).toBe(422);
    expect(await status(cd({ label: "O\u202Ek" }))).toBe(422);
    expect(await status(cd({ target: "2020-01-01T00:00:00Z" }))).toBe(422);
    expect(await status({ palette: { bg: "#000000", fg: "#111111", accent: "#ff4f00" } })).toBe(422);
    expect(await status({ palette: { bg: "#000000", fg: "#ffffff", accent: "#ff4f00" } })).toBe(201);
    // availability, sanctions, content type
    expect(await status({ format: "chart_moment", params: { style: "line", asset: "ETH", window: "7d" } })).toBe(422);
    expect(await status({ buyer: SANCTIONED.address })).toBe(451);
    const bad = await h.request("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(bad.status).toBe(415);
    const err = await (await h.postJson("/v1/quotes", h.quoteBody(cd({ style: "nope" })))).json();
    expect(err).toMatchObject({ error: "unknown_style", message: "countdown styles: tminus" });
  });

  it("fails closed when the OFAC list is stale (> 7 days) and cannot be refreshed", async () => {
    const h = new Harness({ sanctionsFetchedAgoS: 8 * 86_400 });
    h.listFetch = async () => new Response("upstream down", { status: 503 });
    const res = await h.postJson("/v1/quotes", h.quoteBody());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("screening_unavailable");
  });

  it("rate-limits per buyer", async () => {
    const h = new Harness({ env: { QUOTES_PER_BUYER_PER_HOUR: "2" } });
    await h.createQuote();
    await h.createQuote();
    expect((await h.postJson("/v1/quotes", h.quoteBody())).status).toBe(429);
  });
});

describe("render-before-pay: draft → final", () => {
  it("final quote commits to the encrypted file and is consistent with @keyframe/protocol", async () => {
    const h = new Harness();
    const draft = await h.createQuote({ delivery: "private" });
    const { done, enc } = await h.render({ totalBytes: 2_400_000 });
    expect(done?.status).toBe(200);
    const q = (await (await h.request(`/v1/quotes/${draft.quote_id}`)).json()) as Json;
    QuoteSchema.parse(q);
    expect(q.status).toBe("final");
    expect(q.retry_after_ms).toBe(0);

    const t = termsFromJson(q.terms);
    // §1/§2: terms hash and escrow derivation
    expect(hashTerms(t, FACTORY)).toBe(q.terms_hash);
    expect(escrowOf(q.terms_hash, FACTORY)).toBe(q.escrow);
    expect(q.factory).toBe(FACTORY);
    expect(q.vault_impl).toBe(vaultImplOf(FACTORY));
    expect(t.token).toBe(USDC);
    expect(t.seller).toBe(SELLER);
    expect(t.operator).toBe(h.operator);
    expect(t.buyer).toBe(h.buyer.address);
    expect(t.amount).toBe(1_000_000n);
    expect(t.reviewWindow).toBe(0);
    expect(t.dueAt).toBe(0);
    // §4: keys and salt
    const kChain = await deriveKChain(kmasterOf(h), q.quote_id);
    const kBuyer = await deriveKBuyer(kmasterOf(h), q.quote_id);
    expect(t.keyHash).toBe(keyHashOf(kChain));
    expect(t.salt).toBe(saltOf(q.quote_id));
    expect(q.spec.kBuyerHash).toBe(await sha256Hex(hexToBytes(kBuyer)));
    // §6: spec hash covers the approved key frame and what rendered it
    SpecSchema.parse(q.spec);
    expect(await specHash(q.spec)).toBe(q.spec_hash);
    expect(t.specHash).toBe(q.spec_hash);
    expect(q.spec.keyframe).toEqual({ stillSha256: q.preview.still_sha256, atMs: 3000 });
    expect(q.spec.template).toEqual({ id: "countdown", version: "1.0.0", hash: `0x${"ab".repeat(32)}` });
    // §5: contentHash = manifestHash = sha256(JCS(manifest)); manifest and chunks are served at the frozen layout
    expect(t.contentHash).toBe(q.content.manifest_hash);
    expect(await verifyManifest(enc.manifest, q.content.manifest_hash)).toBe(true);
    expect(enc.manifest.chunks).toBe(3);
    const served = await h.request(new URL(q.content.manifest_url).pathname);
    expect(served.status).toBe(200);
    expect(await sha256Hex(new Uint8Array(await served.arrayBuffer()))).toBe(q.content.manifest_hash);
    for (let i = 0; i < 3; i++) {
      const c = await h.request(`/files/c/${q.content.manifest_hash}/${i}.bin`);
      expect(await sha256Hex(new Uint8Array(await c.arrayBuffer()))).toBe(enc.manifest.ciphertext[i]);
    }
    // payment window restarts at finalization; the chosen delivery window (30 min) is preserved
    expect(q.deadline - q.quote_expires_at).toBe(30 * 60);
    expect(q.quote_expires_at).toBe(h.nowS() + 600);
  });

  it("the hidden 0.10 USDC probe SKU (format catalog) goes draft → final → 402", async () => {
    const h = new Harness();
    const q = await h.createQuote({
      format: "catalog",
      params: { catalog_id: "probe", values: { probe_id: "synthetic-1" } },
    });
    expect(q).toMatchObject({ format: "catalog", catalog_id: "probe", price: { atomic: "100000", usdc: "0.10" } });
    expect(q.spec.params).toMatchObject({ catalog_id: "probe", values: { probe_id: "synthetic-1" } });
    const { done } = await h.render({ mp4: fixture("probe-2s-9x16.m4v") });
    expect(done?.status).toBe(200);
    const res = await h.request(`/v1/orders/${q.quote_id}`, { method: "POST" });
    expect(res.status).toBe(402);
    const pr = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString());
    expect(pr.accepts[0].amount).toBe("100000");
    expect(pr.resource.description).toContain(": Probe 2s 9:16.");
  });

  it("the worker's raw K_file equals the protocol's HKDF key (identical ciphertext)", async () => {
    const h = new Harness();
    const qid = (await h.createQuote()).quote_id as string;
    const kChain = await deriveKChain(kmasterOf(h), qid);
    const kBuyer = `0x${"0".repeat(64)}` as const;
    const salt = saltOf(qid);
    const media = { mime: "video/mp4", width: 1080, height: 1920, durationMs: 6000, fps: 30 };
    const pt = fixture("launch-6s-9x16.m4v");
    const ours = await encryptWithRawKey(pt, await rawFileKey(kChain, kBuyer, salt), salt, media);
    const theirs = await encryptKfc1(pt, { kChain, kBuyer, salt, media });
    expect(ours.manifest).toEqual(theirs.manifest);
    expect(Buffer.from(ours.chunks[0] ?? []).equals(Buffer.from(theirs.chunks[0] ?? []))).toBe(true);
  });

  it("rejects artifacts that do not match the deal", async () => {
    const h = new Harness();
    await h.createQuote();
    const claim = await h.internal("/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "worker-1" }),
    });
    const job = (await claim.json()) as Json;
    const put = (path: string, body: BodyInit, type: string) =>
      h.internal(path, { method: "PUT", headers: { "content-type": type }, body });
    // wrong salt
    const media = { mime: "video/mp4", width: 1080, height: 1920, durationMs: 8000, fps: 30 };
    const wrongSalt = await encryptWithRawKey(
      fixture("countdown-8s-9x16.m4v"),
      job.kfc1.k_file,
      `0x${"12".repeat(32)}`,
      media,
    );
    expect((await put(job.upload.manifest, JSON.stringify(wrongSalt.manifest), "application/json")).status).toBe(422);
    // wrong resolution
    const wrongRes = await encryptWithRawKey(fixture("countdown-8s-9x16.m4v"), job.kfc1.k_file, job.kfc1.salt, {
      ...media,
      width: 1920,
      height: 1080,
    });
    expect((await put(job.upload.manifest, JSON.stringify(wrongRes.manifest), "application/json")).status).toBe(422);
    // wrong key: manifest is fine but the chunk fails authentication
    const wrongKey = await encryptWithRawKey(
      fixture("countdown-8s-9x16.m4v"),
      `0x${"34".repeat(32)}`,
      job.kfc1.salt,
      media,
    );
    expect((await put(job.upload.manifest, JSON.stringify(wrongKey.manifest), "application/json")).status).toBe(200);
    const chunk = await put(
      job.upload.chunk.replace("{i}", "0"),
      wrongKey.chunks[0] as Uint8Array<ArrayBuffer>,
      "application/octet-stream",
    );
    expect(chunk.status).toBe(422);
    expect((await chunk.json()).error).toBe("chunk_decrypt");
    // a different manifest after the first one is refused (write-once per attempt)
    const good = await encryptWithRawKey(fixture("countdown-8s-9x16.m4v"), job.kfc1.k_file, job.kfc1.salt, media);
    expect((await put(job.upload.manifest, JSON.stringify(good.manifest), "application/json")).status).toBe(409);
    // still must be an image
    expect((await put(job.upload.still, "not an image", "image/png")).status).toBe(422);
    // done without chunks
    const done = await h.internal(`/jobs/${job.job_id}/done`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(done.status).toBe(409);
  });

  it("render failures re-queue, then cancel the quote after 3 attempts", async () => {
    const h = new Harness();
    const q = await h.createQuote();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = await h.internal("/jobs/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "worker-1" }),
      });
      expect(claim.status).toBe(200);
      const job = (await claim.json()) as Json;
      expect(job.attempt).toBe(attempt);
      const f = await h.internal(`/jobs/${job.job_id}/failed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "chrome crashed" }),
      });
      expect((await f.json()).status).toBe(attempt < 3 ? "queued" : "failed");
    }
    const after = (await (await h.request(`/v1/quotes/${q.quote_id}`)).json()) as Json;
    expect(after.status).toBe("cancelled");
    const claim = await h.internal("/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "worker-1" }),
    });
    expect(claim.status).toBe(204);
  });
});
