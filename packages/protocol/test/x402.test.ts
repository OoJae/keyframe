import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import fc from "fast-check";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  type AcceptV1,
  buildPaymentRequiredV1,
  buildPaymentRequiredV2,
  CAIP2,
  normalizeAccept,
  parsePaymentRequired,
  USDC,
} from "../src/index.js";

const E = getAddress("0xe5c1000000000000000000000000000000009a3f");
const URL_ = "https://api.keyframe.example/v1/orders/q_7Q2MabcdefghijkmnopqrS";
const INPUT = { url: URL_, description: "Keyframe pay-on-delivery order", amount: 4_000_000n, payTo: E } as const;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const v2Body = (accepts: unknown[]) => ({
  x402Version: 2,
  error: "Payment required",
  resource: { url: URL_, description: "d", mimeType: "application/json" },
  accepts,
});
const v2Accept = (patch: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: CAIP2,
  amount: "4000000",
  asset: USDC,
  payTo: E,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
  ...patch,
});
const v1Accept = (patch: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "base",
  maxAmountRequired: "4000000",
  resource: URL_,
  description: "d",
  mimeType: "application/json",
  payTo: E,
  maxTimeoutSeconds: 300,
  asset: USDC,
  extra: { name: "USD Coin", version: "2" },
  ...patch,
});
const res402 = (headers: Record<string, string>, body: unknown = {}) => ({
  status: 402,
  headers,
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});
const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect((e as Error).name).toBe("X402ParseError");
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected X402ParseError ${code}`);
};

describe("buildPaymentRequiredV2 (§7 default wire)", () => {
  const wire = buildPaymentRequiredV2(INPUT);

  it("emits the frozen header JSON, body {} and no-store", () => {
    expect(wire.status).toBe(402);
    expect(wire.body).toBe("{}");
    expect(wire.headers["Cache-Control"]).toBe("no-store");
    expect(wire.headers["Content-Type"]).toBe("application/json");
    const json = Buffer.from(wire.headers["PAYMENT-REQUIRED"] as string, "base64").toString("utf8");
    expect(json).toBe(
      `{"x402Version":2,"error":"Payment required","resource":{"url":"${URL_}","description":"Keyframe pay-on-delivery order","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"4000000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"${E}","maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}]}`,
    );
  });

  it("is byte-identical across calls and checksums payTo", () => {
    expect(buildPaymentRequiredV2({ ...INPUT, amount: "4000000" })).toEqual(wire);
    expect(buildPaymentRequiredV2({ ...INPUT, payTo: E.toLowerCase() as `0x${string}` })).toEqual(wire);
    expect(E).not.toBe(E.toLowerCase());
  });

  it("interops with @x402/core 2.28.0 header codec both ways", () => {
    const header = wire.headers["PAYMENT-REQUIRED"] as string;
    const decoded = decodePaymentRequiredHeader(header);
    expect(encodePaymentRequiredHeader(decoded)).toBe(header);
    const parsed = parsePaymentRequired({ status: 402, headers: new Headers(wire.headers), bodyText: wire.body });
    expect(parsed.version).toBe(2);
    expect(parsed.resource).toEqual({ url: URL_, description: INPUT.description, mimeType: "application/json" });
    expect(parsed.accepts).toEqual(decoded.accepts);
    expect(normalizeAccept(parsed.accepts[0] as never)).toEqual({
      scheme: "exact",
      network: "eip155:8453",
      amount: "4000000",
      asset: USDC,
      payTo: E,
      maxTimeoutSeconds: 300,
    });
  });

  it("parses a header produced by @x402/core's encoder (non-ASCII description)", () => {
    const header = encodePaymentRequiredHeader(v2Body([v2Accept()]) as never);
    const withUnicode = encodePaymentRequiredHeader({
      ...v2Body([v2Accept()]),
      resource: { url: URL_, description: "Ünïcode ✓" },
    } as never);
    expect(parsePaymentRequired(res402({ "payment-required": header })).accepts).toHaveLength(1);
    expect(parsePaymentRequired(res402({ "Payment-Required": withUnicode })).resource?.description).toBe("Ünïcode ✓");
  });

  it("validates its input", () => {
    expect(() => buildPaymentRequiredV2({ ...INPUT, amount: 0n })).toThrow();
    expect(() => buildPaymentRequiredV2({ ...INPUT, amount: "1.5" })).toThrow();
    expect(() => buildPaymentRequiredV2({ ...INPUT, payTo: "0x12" })).toThrow();
    expect(() => buildPaymentRequiredV2({ ...INPUT, url: "not a url" })).toThrow();
    expect(() => buildPaymentRequiredV2({ ...INPUT, maxTimeoutSeconds: 0 })).toThrow();
  });
});

describe("buildPaymentRequiredV1 (X402_WIRE=v1)", () => {
  it("JSON body only, network base, maxAmountRequired", () => {
    const wire = buildPaymentRequiredV1(INPUT);
    expect(wire.headers).toEqual({ "Content-Type": "application/json", "Cache-Control": "no-store" });
    const parsed = parsePaymentRequired({ status: wire.status, headers: wire.headers, bodyText: wire.body });
    expect(parsed.version).toBe(1);
    const a = parsed.accepts[0] as AcceptV1;
    expect(a.network).toBe("base");
    expect(a.maxAmountRequired).toBe("4000000");
    expect(parsed.resource).toEqual({ url: URL_, description: INPUT.description, mimeType: "application/json" });
    expect(normalizeAccept(a)).toMatchObject({ network: "eip155:8453", amount: "4000000", payTo: E, asset: USDC });
  });
});

describe("parsePaymentRequired", () => {
  it("rejects mixed v1 + v2 in one response", () => {
    const header = b64(v2Body([v2Accept()]));
    expectCode(
      () => parsePaymentRequired(res402({ "PAYMENT-REQUIRED": header }, { x402Version: 1, accepts: [v1Accept()] })),
      "mixed_versions",
    );
    expectCode(() => parsePaymentRequired(res402({ "PAYMENT-REQUIRED": header }, { accepts: [] })), "mixed_versions");
    expectCode(
      () => parsePaymentRequired(res402({ "PAYMENT-REQUIRED": b64({ x402Version: 1, accepts: [v1Accept()] }) })),
      "mixed_versions",
    );
    expectCode(() => parsePaymentRequired(res402({}, v2Body([v2Accept()]))), "mixed_versions");
  });

  it("rejects requirements carrying the other version's amount field", () => {
    expectCode(
      () => parsePaymentRequired(res402({ "PAYMENT-REQUIRED": b64(v2Body([v2Accept({ maxAmountRequired: "1" })])) })),
      "invalid_schema",
    );
    expectCode(
      () => parsePaymentRequired(res402({}, { x402Version: 1, accepts: [v1Accept({ amount: "1" })] })),
      "invalid_schema",
    );
  });

  it("surfaces wrong network / asset / scheme / payTo / amount verbatim for the caller to reject", () => {
    const accepts = [
      v2Accept({ network: "eip155:1" }),
      v2Accept({ asset: "0x0000000000000000000000000000000000000001" }),
      v2Accept({ scheme: "upto" }),
      v2Accept({ payTo: "0x000000000000000000000000000000000000dEaD", amount: "50000000" }),
      v2Accept({
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    ];
    const parsed = parsePaymentRequired(res402({ "PAYMENT-REQUIRED": b64(v2Body(accepts)) }));
    expect(parsed.accepts.map((a) => normalizeAccept(a))).toEqual(
      accepts.map((a) => ({
        scheme: a.scheme,
        network: a.network,
        amount: a.amount,
        asset: a.asset,
        payTo: a.payTo,
        maxTimeoutSeconds: 300,
      })),
    );
    const v1 = parsePaymentRequired(
      res402(
        {},
        { x402Version: 1, accepts: [v1Accept({ network: "base-sepolia" }), v1Accept({ network: "megachain" })] },
      ),
    );
    expect(v1.accepts.map((a) => normalizeAccept(a).network)).toEqual(["eip155:84532", "megachain"]);
  });

  it.each([
    ["status 200", { status: 200, headers: {}, bodyText: "{}" }, "not_402"],
    ["no x402 data", res402({}, { quote_id: "q" }), "no_payment_required"],
    ["empty body, no header", res402({}, ""), "no_payment_required"],
    ["html body", res402({}, "<html>pay</html>"), "no_payment_required"],
    ["header not base64", res402({ "PAYMENT-REQUIRED": "%%%" }), "bad_header"],
    ["header base64url alphabet", res402({ "PAYMENT-REQUIRED": "eyJ4-_==" }), "bad_header"],
    ["header not JSON", res402({ "PAYMENT-REQUIRED": Buffer.from("nope").toString("base64") }), "bad_header"],
    [
      "header invalid UTF-8",
      res402({ "PAYMENT-REQUIRED": Buffer.from([0x7b, 0xff, 0x7d]).toString("base64") }),
      "bad_header",
    ],
    ["empty accepts", res402({ "PAYMENT-REQUIRED": b64(v2Body([])) }), "invalid_schema"],
    [
      "v2 missing resource",
      res402({ "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [v2Accept()] }) }),
      "invalid_schema",
    ],
    [
      "v2 network not CAIP-2",
      res402({ "PAYMENT-REQUIRED": b64(v2Body([v2Accept({ network: "base" })])) }),
      "invalid_schema",
    ],
    ["decimal amount", res402({ "PAYMENT-REQUIRED": b64(v2Body([v2Accept({ amount: "4.00" })])) }), "invalid_schema"],
    [
      "negative timeout",
      res402({ "PAYMENT-REQUIRED": b64(v2Body([v2Accept({ maxTimeoutSeconds: -1 })])) }),
      "invalid_schema",
    ],
    ["huge body", res402({}, `{"x":"${"a".repeat(300_000)}"}`), "too_large"],
    ["bad input", null, "bad_input"],
    ["headers missing", { status: 402, bodyText: "{}" }, "bad_input"],
  ])("rejects %s", (_name, res, code) => {
    expectCode(() => parsePaymentRequired(res as never), code);
  });

  it("rejects conflicting duplicate headers", () => {
    const a = b64(v2Body([v2Accept()]));
    const b = b64(v2Body([v2Accept({ amount: "1" })]));
    expectCode(() => parsePaymentRequired(res402({ "PAYMENT-REQUIRED": a, "payment-required": b })), "bad_header");
    const h = new Headers();
    h.append("PAYMENT-REQUIRED", a);
    h.append("PAYMENT-REQUIRED", b);
    expectCode(() => parsePaymentRequired({ status: 402, headers: h, bodyText: "{}" }), "bad_header");
    expect(parsePaymentRequired(res402({ "PAYMENT-REQUIRED": a, "payment-required": a })).version).toBe(2);
  });

  describe("fuzz: never throws anything but X402ParseError", () => {
    const check = (res: unknown) => {
      try {
        const out = parsePaymentRequired(res as never);
        expect([1, 2]).toContain(out.version);
        expect(out.accepts.length).toBeGreaterThan(0);
        for (const a of out.accepts) normalizeAccept(a);
      } catch (e) {
        if ((e as Error)?.name !== "X402ParseError") throw e;
      }
    };

    it("arbitrary values", () => {
      fc.assert(fc.property(fc.anything({ withNullPrototype: true, withBigInt: true, withMap: true }), check), {
        numRuns: 2000,
      });
    });

    it("arbitrary bodies and header strings", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 599 }).chain((s) => fc.constantFrom(s, 402)),
          fc.option(fc.string(), { nil: undefined }),
          fc.string(),
          (status, header, bodyText) =>
            check({ status, headers: header === undefined ? {} : { "PAYMENT-REQUIRED": header }, bodyText }),
        ),
        { numRuns: 3000 },
      );
    });

    it("structurally plausible, mutated payloads (both versions)", () => {
      const json = fc.jsonValue();
      const mutate = (base: Record<string, unknown>) =>
        fc.tuple(fc.constantFrom(...Object.keys(base)), json).map(([k, v]) => ({ ...base, [k]: v }));
      const v2a = mutate(v2Accept());
      const v1a = mutate(v1Accept());
      fc.assert(
        fc.property(
          fc.oneof(
            fc
              .array(v2a, { maxLength: 3 })
              .map((accepts) => ({ headers: { "PAYMENT-REQUIRED": b64(v2Body(accepts)) }, body: "{}" })),
            fc
              .array(v1a, { maxLength: 3 })
              .map((accepts) => ({ headers: {}, body: JSON.stringify({ x402Version: 1, accepts }) })),
            fc.tuple(fc.array(v2a, { maxLength: 2 }), fc.array(v1a, { maxLength: 2 })).map(([a2, a1]) => ({
              headers: { "PAYMENT-REQUIRED": b64(v2Body(a2)) },
              body: JSON.stringify({ x402Version: 1, accepts: a1 }),
            })),
            mutate(v2Body([v2Accept()])).map((pr) => ({ headers: { "PAYMENT-REQUIRED": b64(pr) }, body: "" })),
          ),
          ({ headers, body }) => check({ status: 402, headers, bodyText: body }),
        ),
        { numRuns: 3000 },
      );
    });
  });
});
