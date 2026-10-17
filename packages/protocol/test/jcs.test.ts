import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { jcs, sha256Hex, specHash } from "../src/index.js";

// Test data from RFC 8785 (§3.2.2, §3.2.3, §3.2.4, Appendix B). The Keyframe profile is integers-only, so the
// float members of the RFC sample must be rejected while everything else must match byte for byte.

// The RFC's JSON text for the sample string, escapes intact (decoded by JSON.parse, not by the TS compiler).
const RFC_SAMPLE_JSON = '"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/"';
const RFC_SAMPLE_STRING: string = JSON.parse(RFC_SAMPLE_JSON);

describe("jcs (RFC 8785)", () => {
  it("§3.2.2/3.2.3 sample: literals + string members canonicalize exactly as the RFC prints them", () => {
    const parsed = JSON.parse(`{"string": ${RFC_SAMPLE_JSON}, "literals": [null, true, false]}`);
    expect(parsed.string).toBe(`${String.fromCodePoint(0x20ac)}$${String.fromCharCode(0x0f)}\nA'B"\\\\"/`);
    expect(jcs(parsed)).toBe(String.raw`{"literals":[null,true,false],"string":"€$\u000f\nA'B\"\\\\\"/"}`);
  });

  it("§3.2.4 UTF-8 bytes: RFC bytes minus the (float) numbers member equal our output", () => {
    const rfcHex = `
      7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
      75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
      5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
      65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
      5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
      30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`.replace(/\s+/g, "");
    const rfcText = Buffer.from(rfcHex, "hex").toString("utf8");
    const numbersMember = '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],';
    expect(rfcText).toContain(numbersMember);
    const expected = Buffer.from(rfcText.replace(numbersMember, ""), "utf8");
    const ours = Buffer.from(jcs({ string: RFC_SAMPLE_STRING, literals: [null, true, false] }), "utf8");
    expect(ours.equals(expected)).toBe(true);
  });

  it("§3.2.2 sample with its float members is rejected (integers-only profile)", () => {
    const parsed = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "literals": [null, true, false]}',
    );
    expect(() => jcs(parsed)).toThrow(/safe integer/);
  });

  it("§3.2.3 property sorting test data (UTF-16 code unit order)", () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    const values = Object.values(JSON.parse(jcs(input)) as Record<string, string>);
    const order = [...jcs(input).matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
    expect(values).toHaveLength(7);
    const c = (...cps: number[]) => String.fromCodePoint(...cps);
    expect(jcs(input)).toBe(
      `{"\\r":"Carriage Return","1":"One","${c(0x80)}":"Control","${c(0xf6)}":"Latin Small Letter O With Diaeresis",` +
        `"${c(0x20ac)}":"Euro Sign","${c(0x1f600)}":"Emoji: Grinning Face","${c(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`,
    );
  });

  it("Appendix B integer samples", () => {
    expect(jcs(0)).toBe("0");
    expect(jcs(-0)).toBe("0");
    expect(jcs(9007199254740991)).toBe("9007199254740991");
    expect(jcs(-9007199254740991)).toBe("-9007199254740991");
    for (const bad of [
      9007199254740992,
      -9007199254740992,
      295147905179352830000,
      1e21,
      5e-324,
      Number.NaN,
      Infinity,
    ]) {
      expect(() => jcs(bad)).toThrow();
    }
  });

  it("escapes control characters exactly", () => {
    const ls = String.fromCharCode(0x2028);
    expect(jcs(`\b\t\n\f\r${String.fromCharCode(0, 0x1f, 0x7f)}${ls}`)).toBe(
      `"\\b\\t\\n\\f\\r\\u0000\\u001f${String.fromCharCode(0x7f)}${ls}"`,
    );
  });

  it("rejects values outside the profile", () => {
    for (const bad of [
      undefined,
      1n,
      () => 1,
      Symbol("x"),
      new Date(0),
      new Uint8Array(1),
      [undefined],
      ["\ud800"],
      { "\udc00": 1 },
    ]) {
      expect(() => jcs(bad)).toThrow();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jcs(cyclic)).toThrow(/cyclic/);
    // biome-ignore lint/suspicious/noSparseArray: sparse arrays must be rejected
    expect(() => jcs([1, , 2])).toThrow();
  });

  it("omits undefined members like JSON.stringify; shared (non-cyclic) references are fine", () => {
    expect(jcs({ b: 1, a: undefined, c: [true] })).toBe('{"b":1,"c":[true]}');
    const shared = { x: 1 };
    expect(jcs({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("is a canonical form: order-independent, idempotent, JSON round-trippable", () => {
    const json = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.string({ unit: "grapheme" }),
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("value"), { maxLength: 4 }),
        fc.dictionary(fc.string({ unit: "grapheme" }), tie("value"), { maxKeys: 4 }),
      ),
    })).value;
    fc.assert(
      fc.property(json, (v) => {
        const c = jcs(v);
        expect(JSON.parse(c)).toEqual(v);
        expect(jcs(JSON.parse(c))).toBe(c);
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const reversed = Object.fromEntries(Object.entries(v).reverse());
          expect(jcs(reversed)).toBe(c);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("sha256Hex / specHash", () => {
  it("matches node:crypto for bytes and UTF-8 strings", async () => {
    const nodeSha = (b: Uint8Array | string) => `0x${createHash("sha256").update(b).digest("hex")}`;
    expect(await sha256Hex("")).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("€ keyframe")).toBe(nodeSha("€ keyframe"));
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(await sha256Hex(bytes)).toBe(nodeSha(bytes));
    expect(await sha256Hex(bytes.subarray(1, 3))).toBe(nodeSha(bytes.subarray(1, 3)));
  });

  it("specHash = sha256(JCS(spec)) regardless of member order", async () => {
    const a = { v: 1, tier: "instant", params: { b: 2, a: 1 } };
    const b = { params: { a: 1, b: 2 }, tier: "instant", v: 1 };
    expect(await specHash(a)).toBe(await specHash(b));
    expect(await specHash(a)).toBe(await sha256Hex('{"params":{"a":1,"b":2},"tier":"instant","v":1}'));
    await expect(specHash({ v: 1.5 })).rejects.toThrow();
  });
});
