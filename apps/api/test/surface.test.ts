import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, catalogItem } from "../src/catalog.js";
import { parseConfig } from "../src/config.js";
import { Harness, WORKER_TOKEN } from "./support/harness.js";

describe("public surface", () => {
  it("/v1/styles lists the catalog with prices, hides the probe, filters by tier/format", async () => {
    const h = new Harness();
    const all = await (await h.request("/v1/styles")).json();
    const ids = all.formats.map((f: { id: string }) => f.id);
    expect(ids).toEqual([
      "launch_sting",
      "countdown",
      "portfolio_pulse",
      "kinetic_post",
      "chart_moment",
      "studio_sting",
      "studio_spot",
    ]);
    const launch = all.formats[0];
    expect(launch.prices).toEqual([
      { duration_s: 6, atomic: "4000000", usdc: "4.00" },
      { duration_s: 10, atomic: "7000000", usdc: "7.00" },
    ]);
    expect(launch.price_usdc).toEqual({ "6": "4.00", "10": "7.00" });
    const byId = (id: string) => all.formats.find((f: { id: string }) => f.id === id);
    expect(byId("chart_moment").available).toBe(false);
    expect(byId("countdown")).toMatchObject({ available: true, styles: ["tminus"] });
    // Instant formats are sellable only once their template is designed (templates/<id>/template.json)
    expect(byId("launch_sting").available).toBe(catalogItem("launch_sting")?.renderable);
    expect(byId("studio_sting").available).toBe(true);
    expect(all.studio).toEqual({
      seller: h.s.cfg.seller,
      operators: [h.operator],
      factory: h.s.cfg.factory,
      vault_impl: h.s.cfg.vaultImpl,
    });
    const studio = await (await h.request("/v1/styles?tier=studio")).json();
    expect(studio.formats.map((f: { price?: unknown; prices: { usdc: string }[] }) => f.prices[0]?.usdc)).toEqual([
      "25.00",
      "50.00",
    ]);
    const one = await (await h.request("/v1/styles?format=countdown")).json();
    expect(one.formats).toHaveLength(1);
    expect(one.formats[0].prices[0].usdc).toBe("1.00");
  });

  it("/health, /v1/stats, /llms.txt, /openapi.json", async () => {
    const h = new Harness();
    const health = await (await h.request("/health")).json();
    expect(health).toMatchObject({ ok: true, chain_id: 8453, x402_wire: "v2", configured: true, storage: "memory" });
    expect(JSON.stringify(health)).not.toContain(h.kmasterHex.slice(2, 18));
    expect(JSON.stringify(health)).not.toContain(WORKER_TOKEN);
    const stats = await (await h.request("/v1/stats")).json();
    expect(stats).toMatchObject({ v: 1, quotes: 0, orders: 0 });
    const llms = await h.request("/llms.txt");
    expect(llms.headers.get("content-type")).toContain("text/plain");
    expect(await llms.text()).toContain("/v1/orders/{quote_id}");
    const oa = await (await h.request("/openapi.json")).json();
    expect(oa.openapi).toBe("3.1.0");
    expect(Object.keys(oa.paths)).toContain("/v1/orders/{quote_id}");
  });

  it("/v1/styles and /health say when the render studio is offline (Instant only)", async () => {
    const h = new Harness();
    h.stopRenderWorker();
    const styles = async () => {
      const all = await (await h.request("/v1/styles")).json();
      return (id: string) => all.formats.find((f: { id: string }) => f.id === id);
    };
    let byId = await styles();
    expect(byId("countdown")).toMatchObject({ available: false, availability: "studio offline" });
    expect(byId("studio_sting").available).toBe(true);
    expect(byId("studio_sting").availability).toBeUndefined();
    expect(byId("launch_sting").availability).toBe("not available yet");
    for (const id of ["launch_sting", "countdown", "portfolio_pulse", "kinetic_post", "chart_moment"]) {
      expect(byId(id).availability.length, id).toBeLessThanOrEqual(30); // the plugin prints ≤30 chars
    }
    expect((await (await h.request("/health")).json()).render).toMatchObject({
      online: false,
      last_worker_seen_s: null,
      queue: 0,
    });
    // the render worker polls once
    await h.internal("/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "mac-1" }),
    });
    byId = await styles();
    expect(byId("countdown").available).toBe(true);
    expect(byId("countdown").availability).toBeUndefined();
    expect((await (await h.request("/health")).json()).render).toMatchObject({ online: true, last_worker_seen_s: 0 });
    h.advance(121);
    expect((await styles())("countdown").availability).toBe("studio offline");
  });

  it("llms.txt marks formats whose template is not designed as not available, even with FORMATS_DISABLED empty", async () => {
    const h = new Harness({ env: { FORMATS_DISABLED: "" } });
    const llms = await (await h.request("/llms.txt")).text();
    for (const i of CATALOG.filter((x) => !x.hidden)) {
      const line = llms.split("\n").find((l) => l.startsWith(`- ${i.id} (`));
      expect(line, i.id).toBeDefined();
      expect(line?.endsWith("(not available yet)"), i.id).toBe(!i.renderable);
    }
    expect(llms).toMatch(/- countdown \(instant\): Countdown\. 8s 1\.00 USDC\.$/m);
    expect(llms).toContain("503 studio_offline");
  });

  it("the shipped wrangler.toml switches off every Instant format without a designed template", () => {
    const toml = readFileSync(join(import.meta.dirname, "../wrangler.toml"), "utf8");
    const disabled = parseConfig({ FORMATS_DISABLED: /^FORMATS_DISABLED = "(.*)"$/m.exec(toml)?.[1] }).formatsDisabled;
    expect([...disabled].sort()).toEqual(["chart_moment", "kinetic_post", "launch_sting", "portfolio_pulse"]);
    expect(toml).toMatch(/^WORKER_STALE_S = "120"$/m);
  });

  it("disclosures: public delivery is openable by anyone with the link, pieces are silent, quotes are free", async () => {
    const h = new Harness();
    const q = await h.createQuote();
    const publicLine = q.disclosures.find((d: string) => d.startsWith("Public delivery:"));
    expect(publicLine).toContain("anyone with the link can open the file");
    expect(publicLine).toContain('delivery "private"');
    expect(q.disclosures).toContain("Instant pieces are silent (no sound) until studio sound ships.");
    expect(q.disclosures.length).toBeLessThanOrEqual(12); // the plugin keeps 12
    for (const d of q.disclosures) expect(d.length).toBeLessThanOrEqual(500);
    const rules: string[] = (await (await h.request("/v1/styles")).json()).policy.rules;
    const llms = await (await h.request("/llms.txt")).text();
    for (const text of [publicLine, "Instant pieces are silent", "Quotes are free", "named presets are not designed"]) {
      expect(
        rules.some((r) => r.includes(text)),
        text,
      ).toBe(true);
      expect(llms, text).toContain(text);
    }
  });

  it("/internal/* requires the worker bearer token; job calls require the holder's X-Worker-Id", async () => {
    const h = new Harness();
    await h.createQuote();
    const claim = (headers: Record<string, string>) =>
      h.request("/internal/jobs/claim", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ worker_id: "w" }),
      });
    expect((await claim({})).status).toBe(401);
    expect((await claim({ authorization: "Bearer wrong" })).status).toBe(401);
    const ok = await claim({ authorization: `Bearer ${WORKER_TOKEN}` });
    expect(ok.status).toBe(200);
    const job = await ok.json();
    const other = await h.request(`/internal/jobs/${job.job_id}`, {
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, "x-worker-id": "someone-else" },
    });
    expect(other.status).toBe(403);
    const mine = await h.request(`/internal/jobs/${job.job_id}`, {
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, "x-worker-id": "w" },
    });
    expect(mine.status).toBe(200);
    const inputs = await mine.json();
    expect(inputs.kfc1.k_file).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(inputs)).not.toContain(h.kmasterHex.slice(2));
  });

  it("files are served only for the public key layout", async () => {
    const h = new Harness();
    await h.storage.put("secret/thing", new Uint8Array([1]), "application/octet-stream");
    expect((await h.request("/files/secret/thing")).status).toBe(404);
    expect((await h.request("/files/c/0xnothex/manifest.json")).status).toBe(404);
  });

  it("config: misconfiguration is reported and blocks quoting (503) without leaking values", async () => {
    const cfg = parseConfig({ PUBLIC_BASE_URL: "http://example.com/path", KMASTER: "abcd" });
    expect(cfg.problems.join("\n")).toMatch(/PUBLIC_BASE_URL|KMASTER|FACTORY_ADDRESS|RELAYER_PRIVATE_KEY/);
    expect(cfg.problems.join("\n")).not.toContain("abcd");
    const h = new Harness();
    (h.s.cfg as unknown as { problems: string[] }).problems = ["FACTORY_ADDRESS missing"];
    expect((await h.postJson("/v1/quotes", h.quoteBody())).status).toBe(503);
  });

  it("unknown routes and bad ids are JSON 404s; order ids are GET-only", async () => {
    const h = new Harness();
    expect((await h.request("/nope")).status).toBe(404);
    expect((await h.request("/v1/quotes/q_bad")).status).toBe(404);
    expect((await h.request("/v1/orders/o_1111111111111111111111")).status).toBe(404);
    expect((await h.request("/v1/orders/o_1111111111111111111111", { method: "POST" })).status).toBe(405);
  });
});
