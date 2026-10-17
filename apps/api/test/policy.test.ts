import { describe, expect, it } from "vitest";
import { checkPolicy, unsupportedOption } from "../src/quotes/policy.js";
import { parseQuoteRequest, type QuoteRequest } from "../src/quotes/request.js";
import { DESIGNED_PALETTES } from "../src/templates.js";
import { Harness } from "./support/harness.js";

// F13 (crypto-native names are names, not links) and F08 (no silently ignored options).

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
const pulse = (params: Record<string, unknown>) =>
  request({
    format: "portfolio_pulse",
    params: { style: "any", as_of: new Date(now * 1000).toISOString(), ...params },
  });
const brief = (text: string) =>
  request({ format: "studio", params: { deliverable: "studio_sting", brief: text.padEnd(40, ".") } });
const verdict = (r: QuoteRequest) => checkPolicy(r, now);

describe("F13 names: name-service names and brand domains are names, links are still refused", () => {
  for (const label of [
    "ripcord.eth",
    "jesse.base.eth",
    "dao.sol",
    "RIPCORD.ETH",
    "ripcord.eth mainnet",
    "@jesse.base.eth goes live",
    "Live on ripcord.eth.",
    "Next.js 15 launch",
    "keyframe.xyz",
    "pump.fun",
    "base.org",
  ]) {
    it(`countdown label accepts "${label}"`, () => expect(verdict(countdown({ label }))).toEqual({ ok: true }));
  }
  it("accepts ENS names and brand domains in the other name fields", () => {
    expect(verdict(sting({ wordmark: "vitalik.eth" }))).toEqual({ ok: true });
    expect(verdict(sting({ wordmark: "keyframe.xyz" }))).toEqual({ ok: true });
    const holdings = [{ symbol: "ETH", change_24h: 0.01 }];
    expect(verdict(pulse({ title: "jesse.base.eth bag", handle: "@ripcord.eth", holdings }))).toEqual({ ok: true });
  });

  for (const [field, value] of [
    ["label", "claim at drainer.com"],
    ["label", "pump.fun is live, go"],
    ["label", "visit vitalik.eth.limo"],
    ["label", "x.eth/claim"],
    ["label", "ripcord.eth.com mainnet"],
    ["label", "www.pump.fun"],
    ["label", "https://ripcord.eth"],
    ["label", "drainer\uFF0Ecom"], // fullwidth dot: a lookalike, not the brand's own spelling
    ["label", "xn--80ak6aa92e.com"],
    ["cta", "ripcord.eth"], // a call to action naming a payee is a link
    ["cta", "pump.fun"],
  ] as const) {
    it(`still refuses ${field} ${JSON.stringify(value)}`, () => {
      expect(verdict(countdown({ [field]: value }))).toEqual({
        ok: false,
        reason: "links_not_allowed_in_text",
        field: `params.${field}`,
      });
    });
  }
  it("names do not bypass the denylist or the spoofing checks", () => {
    expect(verdict(countdown({ label: "nazi.eth" }))).toMatchObject({ ok: false, reason: "disallowed_content" });
    expect(verdict(countdown({ label: "seed phrase.sol" }))).toMatchObject({ ok: false, reason: "disallowed_content" });
    expect(verdict(countdown({ label: "rip\u202Ecord.eth" }))).toMatchObject({
      ok: false,
      reason: "forbidden_characters",
    });
  });

  it("Studio briefs may name sites (read by the designer, never rendered); URLs go in references", () => {
    expect(verdict(brief("A launch sting for pump.fun and base.org, made by ripcord.eth, calm"))).toEqual({ ok: true });
    expect(verdict(brief("Match the board at https://pump.fun/board please, calm and precise"))).toEqual({
      ok: false,
      reason: "put_links_in_references",
      field: "params.brief",
    });
    expect(verdict(brief("Our deck lives at www.keyframe.xyz/deck, calm and precise"))).toMatchObject({ ok: false });
    expect(verdict(brief("A sting about a seed phrase giveaway for our community"))).toMatchObject({
      ok: false,
      reason: "disallowed_content",
    });
  });
});

describe("F13 get_portfolio passed through verbatim", () => {
  // Illustrative shape (the live field names are unverified): logo/explorer URLs, addresses and chain ids are data
  // the card never prints.
  const portfolio = {
    address: "0x1111111111111111111111111111111111111111",
    chain: "base",
    total_usd: 1234.56,
    explorer_url: "https://basescan.org/address/0x1111111111111111111111111111111111111111",
    tokens: [
      {
        symbol: "USDC",
        name: "USD Coin",
        contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        logo_url: "https://assets.example.com/usdc.png",
        logoURI: "ipfs://bafy/usdc.png",
        chain: "base.mainnet",
        balance: "1000.5",
        usd: 1000.5,
        change_24h: 0.0001,
      },
      { symbol: "ETH", name: "Ether", logo: "https://assets.example.com/eth.svg", usd: 234.06, change_24h: -0.021 },
    ],
  };

  it("accepts a verbatim result with logo and explorer URLs in fields the card never renders", () => {
    expect(verdict(pulse({ portfolio }))).toEqual({ ok: true });
  });

  it("still checks the fields a card prints (token names and symbols)", () => {
    const withToken = (i: number, patch: Record<string, unknown>) => ({
      ...portfolio,
      tokens: portfolio.tokens.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    });
    expect(verdict(pulse({ portfolio: withToken(1, { name: "Visit claim-usdc.com to claim" }) }))).toEqual({
      ok: false,
      reason: "links_not_allowed_in_text",
      field: "params.portfolio.tokens.1.name",
    });
    expect(verdict(pulse({ portfolio: withToken(0, { symbol: "NAZI" }) }))).toMatchObject({
      ok: false,
      reason: "disallowed_content",
    });
  });
});

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
