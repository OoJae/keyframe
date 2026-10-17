import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { Budget, fetchBounded, NetError, PER_CALL_MAX_MS } from "../src/core/net.js";
import { crossRead } from "../src/core/rpc.js";
import { capJson, clean, usdc } from "../src/core/text.js";
import { chooseRoute, type WalletView } from "../src/core/wallet.js";
import { detect7702 } from "../src/protocol/index.js";
import { setup } from "./harness/inproc.js";
import { FACTORY, HOSTS, VAULT } from "./harness/world.js";

describe("config (§9 env vars, fail-closed)", () => {
  it("defaults: offline-safe origins, empty allowlists, 50 USDC cap, x402, direct-first, not paused", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      apiBase: "https://api.keyframe.studio",
      factories: [],
      sellers: [],
      operators: [],
      maxAmount: 50_000_000n,
      primaryRail: "x402",
      policy7702: "direct-first",
      maintenance: false,
      problems: [],
    });
    expect(c.rpcUrls).toHaveLength(2);
  });

  it("rejects invalid values by name and falls back to fail-closed defaults", () => {
    const c = loadConfig({
      KEYFRAME_API_BASE: "http://insecure.example",
      KEYFRAME_FACTORIES: "[{]",
      KEYFRAME_SELLERS: "0xnot-an-address",
      KEYFRAME_MAX_AMOUNT: "1.5",
      KEYFRAME_MAINTENANCE: "maybe",
      KEYFRAME_PRIMARY_RAIL: "card",
    });
    expect(c.problems.sort()).toEqual(
      [
        "KEYFRAME_API_BASE",
        "KEYFRAME_FACTORIES",
        "KEYFRAME_MAINTENANCE",
        "KEYFRAME_MAX_AMOUNT",
        "KEYFRAME_PRIMARY_RAIL",
        "KEYFRAME_SELLERS",
      ].sort(),
    );
    expect(c.maintenance).toBe(true);
    expect(c.maxAmount).toBe(0n);
    expect(c.factories).toEqual([]);
  });

  it("clamps KEYFRAME_MAX_AMOUNT to the 50 USDC hard cap", () => {
    expect(loadConfig({ KEYFRAME_MAX_AMOUNT: "999000000" }).maxAmount).toBe(50_000_000n);
    expect(loadConfig({ KEYFRAME_MAX_AMOUNT: "8000000" }).maxAmount).toBe(8_000_000n);
  });

  it("requires each factory's vaultImpl to be its nonce-1 CREATE address", () => {
    const ok = loadConfig({
      KEYFRAME_FACTORIES: JSON.stringify([{ address: FACTORY, vaultImpl: VAULT, status: "active" }]),
    });
    expect(ok.factories).toHaveLength(1);
    const bad = loadConfig({
      KEYFRAME_FACTORIES: JSON.stringify([{ address: FACTORY, vaultImpl: FACTORY, status: "active" }]),
    });
    expect(bad.problems).toContain("KEYFRAME_FACTORIES");
    expect(bad.factories).toEqual([]);
  });

  it("never puts a value in a problem report", () => {
    const c = loadConfig({ KEYFRAME_RPC_URLS: "https://user:pass@rpc.example/v2/SECRET" });
    expect(JSON.stringify(c.problems)).not.toMatch(/SECRET|pass/);
  });
});

describe("Budget and bounded fetch", () => {
  it("never gives a request more than 4 s nor more than the remaining budget", () => {
    let t = 0;
    const b = new Budget(8_500, () => t);
    expect(b.slot(10_000)).toBe(PER_CALL_MAX_MS);
    t = 6_000;
    expect(b.slot()).toBe(2_200);
    t = 8_100;
    expect(b.slot()).toBe(0);
  });

  it("times out a slow host at the slot and classifies the failure without the URL", async () => {
    const world = setup();
    world.delays.set("api.kf.test", 3_000);
    const t0 = Date.now();
    const err = await fetchBounded(`${HOSTS.api}/v1/styles`, {}, new Budget(1_500), { maxBytes: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(NetError);
    expect((err as NetError).kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect((err as Error).message).not.toContain("kf.test");
  });

  it("refuses redirects and oversize bodies", async () => {
    const world = setup();
    const orig = world.handle.bind(world);
    world.handle = async (req) =>
      new URL(req.url).pathname === "/r"
        ? new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
        : orig(req);
    expect(
      ((await fetchBounded(`${HOSTS.api}/r`, {}, new Budget(), { maxBytes: 10 }).catch((e) => e)) as NetError).kind,
    ).toBe("redirect");
    expect(
      ((await fetchBounded(`${HOSTS.api}/v1/styles`, {}, new Budget(), { maxBytes: 10 }).catch((e) => e)) as NetError)
        .kind,
    ).toBe("too_large");
  });
});

describe("JSON-RPC cross-read", () => {
  const read = { key: "x", req: { method: "eth_chainId", params: [] }, decode: (r: unknown) => String(r) };

  it("agrees when both RPCs agree, flags disagreement and missing answers", async () => {
    const world = setup();
    let r = await crossRead([HOSTS.rpc1, HOSTS.rpc2], [read], new Budget());
    expect(r.get(read)).toEqual({ value: "0x2105", seen: 2, agree: true, values: ["0x2105", "0x2105"] });
    world.hooks.rpc = (host, _m, _p, res) => (host === "rpc2.kf.test" ? "0x1" : res);
    r = await crossRead([HOSTS.rpc1, HOSTS.rpc2], [read], new Budget());
    expect(r.get(read).agree).toBe(false);
    world.down.add("rpc1.kf.test");
    r = await crossRead([HOSTS.rpc1, HOSTS.rpc2], [read], new Budget());
    expect(r.responded).toBe(1);
    expect(r.get(read).seen).toBe(1);
  });

  it("survives garbage batch responses", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600 } }), { status: 200 }),
    );
    const r = await crossRead([HOSTS.rpc1], [read], new Budget());
    expect(r.responded).toBe(0);
    expect(r.get(read).value).toBeUndefined();
  });
});

describe("7702 detection and routing (P8)", () => {
  const cfg = loadConfig({});
  const w = (kind: WalletView["kind"], eth: string | null, usdcAtomic = "10000000"): WalletView => ({
    address: "0x1111111111111111111111111111111111111111",
    kind,
    delegate: null,
    usdc_atomic: usdcAtomic,
    eth_wei: eth,
    shortfall_atomic: BigInt(usdcAtomic) < 4_000_000n ? (4_000_000n - BigInt(usdcAtomic)).toString() : null,
    consistent: true,
  });

  it("classifies code", () => {
    expect(detect7702("0x")).toBe("plain");
    expect(detect7702(`0xef0100${"11".repeat(20)}`)).toBe("delegated");
    expect(detect7702(`0xef0100${"11".repeat(19)}`)).toBe("contract");
    expect(detect7702("0x6080")).toBe("contract");
  });

  it("plain -> x402; delegated+ETH -> direct; delegated w/o ETH -> x402 + note; shortfall -> fund_first; contract -> direct", () => {
    expect(chooseRoute(cfg, w("plain", "0"), 4_000_000n).kind).toBe("x402");
    expect(chooseRoute(cfg, w("delegated", "100000000000000"), 4_000_000n).kind).toBe("direct");
    const noEth = chooseRoute(cfg, w("delegated", "0"), 4_000_000n);
    expect(noEth.kind).toBe("x402");
    expect(noEth.reason).toMatch(/auto-undelegate/);
    expect(chooseRoute(cfg, w("plain", "0", "1000000"), 4_000_000n).kind).toBe("fund_first");
    expect(chooseRoute(cfg, w("contract", "100000000000000"), 4_000_000n).kind).toBe("direct");
    expect(chooseRoute(cfg, w("contract", "0"), 4_000_000n).kind).toBe("fund_first");
    expect(chooseRoute(cfg, w("unknown", null, "10000000"), 4_000_000n).kind).toBe("x402");
  });
});

describe("untrusted text caps", () => {
  it("strips control and bidi characters and caps length", () => {
    expect(clean("a\u202eb\u0000c\nd", 100)).toBe("abc d");
    expect(clean("x".repeat(300), 10)).toHaveLength(10);
  });

  it("capJson bounds strings, arrays, keys and depth for any input (fuzz)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const out = JSON.stringify(capJson(v, { maxString: 20, maxArray: 3, maxKeys: 3, maxDepth: 3 }) ?? null);
        return out.length < 20_000;
      }),
      { numRuns: 500 },
    );
  });

  it("usdc formatting is exact", () => {
    expect(usdc(4_000_000n)).toBe("4.00");
    expect(usdc("100000")).toBe("0.10");
    expect(usdc("1234567")).toBe("1.234567");
  });
});
