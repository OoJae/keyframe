import { describe, expect, it } from "vitest";
import { unsupportedOption } from "../src/quotes/policy.js";
import { parseQuoteRequest, type QuoteRequest } from "../src/quotes/request.js";
import { DESIGNED_PALETTES } from "../src/templates.js";
import { Harness } from "./support/harness.js";

// F08 (no silently ignored options).

const now = Math.floor(Date.now() / 1000);
const target = new Date((now + 86_400) * 1000).toISOString();
const BUYER = `0x${"1".repeat(40)}`;

function request(body: Record<string, unknown>): QuoteRequest {
  const p = parseQuoteRequest({ buyer: BUYER, rights_confirmed: true, ...body });
  if (!p.ok) throw new Error(JSON.stringify(p));
  return p.request;
}
const countdown = (params: Record<string, unknown>) =>
  request({ format: "countdown", params: { style: "tminus", label: "Mainnet", target, ...params } });
const sting = (params: Record<string, unknown>) =>
  request({ format: "launch_sting", params: { style: "any", wordmark: "Ok", ...params } });

describe("F08 options that nothing renders yet get an explicit 422", () => {
  it("palette presets that are not designed (templates/_kit/palettes.json null) are refused; custom colours work", () => {
    for (const preset of ["void", "paper", "signal", "mono", "ember"]) {
      const u = unsupportedOption({ ...countdown({}), palette: preset as "void" });
      if (DESIGNED_PALETTES.has(preset)) expect(u).toBeNull();
      else
        expect(u).toMatchObject({ field: "palette", detail: expect.stringContaining(`"${preset}" is not designed`) });
    }
    expect(unsupportedOption({ ...countdown({}), palette: "ember" }, new Set(["ember"]))).toBeNull();
    const custom = { bg: "#000000", fg: "#ffffff", accent: "#ff4f00" };
    expect(unsupportedOption({ ...countdown({}), palette: custom })).toBeNull();
    expect(unsupportedOption(countdown({}))).toBeNull();
  });

  it("launch_sting logo_url is refused while no template renders logos", () => {
    expect(unsupportedOption(sting({ logo_url: "https://example.com/logo.png" }))).toEqual({
      field: "params.logo_url",
      detail: "launch_sting does not render logos yet; omit logo_url",
    });
    expect(unsupportedOption(sting({}))).toBeNull();
  });

  it("POST /v1/quotes answers 422 unsupported_option with a plain, actionable message", async () => {
    const h = new Harness();
    const res = await h.postJson("/v1/quotes", h.quoteBody({ palette: "ember" }));
    expect(res.status).toBe(422);
    const e = await res.json();
    expect(e).toMatchObject({ error: "unsupported_option", field: "palette" });
    expect(e.message).toBe(
      'palette preset "ember" is not designed yet; omit palette to use the style\'s own colours, or pass {bg, fg, accent} as #RRGGBB',
    );
    expect(h.db.query("SELECT id FROM quotes")).toHaveLength(0);
    // the countdown template does read custom colours (its bg/fg/accent variables)
    const custom = { bg: "#000000", fg: "#ffffff", accent: "#ff4f00" };
    expect((await h.postJson("/v1/quotes", h.quoteBody({ palette: custom }))).status).toBe(201);
  });

  it("an unavailable format still answers format_unavailable before an unsupported option", async () => {
    const h = new Harness();
    const params = { style: "any", wordmark: "Ok", logo_url: "https://example.com/l.png" };
    const res = await h.postJson("/v1/quotes", h.quoteBody({ format: "launch_sting", params }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("format_unavailable");
  });
});
