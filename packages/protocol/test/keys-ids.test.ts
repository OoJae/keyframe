import { createHmac } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { deriveKBuyer, deriveKChain, detect7702, keyHashOf, newOrderId, newQuoteId, saltOf } from "../src/index.js";

const KMASTER = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
const nodeHmac = (key: Uint8Array, msg: string) => `0x${createHmac("sha256", key).update(msg, "utf8").digest("hex")}`;

describe("keys (§4)", () => {
  it("K_chain / K_buyer = HMAC-SHA256(KMASTER, label ‖ quote_id), checked against node:crypto", async () => {
    const q = "q_7Q2MabcdefghijkmnopqrS";
    expect(await deriveKChain(KMASTER, q)).toBe(nodeHmac(KMASTER, `kf/kchain/v1/${q}`));
    expect(await deriveKBuyer(KMASTER, q)).toBe(nodeHmac(KMASTER, `kf/kbuyer/v1/${q}`));
    expect(await deriveKChain(KMASTER, q)).not.toBe(await deriveKBuyer(KMASTER, q));
    expect(await deriveKChain(KMASTER, q)).not.toBe(await deriveKChain(KMASTER, `${q}x`));
  });

  it("rejects short KMASTER and empty quote ids", async () => {
    await expect(deriveKChain(new Uint8Array(31), "q_x")).rejects.toThrow(/KMASTER/);
    await expect(deriveKBuyer(KMASTER, "")).rejects.toThrow(/quoteId/);
  });

  it("keyHash = keccak256 of the 32 raw key bytes", () => {
    const k = `0x${"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"}` as const;
    expect(keyHashOf(k)).toBe(keccak256(k));
    expect(keyHashOf(k)).not.toBe(keccak256(stringToBytes(k)));
    expect(() => keyHashOf("0x1234")).toThrow(/kChain/);
  });
});

describe("ids", () => {
  it("q_/o_ + 22 base58 characters, unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const q = newQuoteId();
      const o = newOrderId();
      expect(q).toMatch(/^q_[1-9A-HJ-NP-Za-km-z]{22}$/);
      expect(o).toMatch(/^o_[1-9A-HJ-NP-Za-km-z]{22}$/);
      ids.add(q).add(o);
    }
    expect(ids.size).toBe(4000);
  });

  it("uses the whole base58 alphabet", () => {
    const seen = new Set(Array.from({ length: 400 }, () => newQuoteId().slice(2)).join(""));
    expect(seen.size).toBe(58);
  });

  it("saltOf = keccak256(utf8(quote_id))", () => {
    expect(saltOf("q_abc")).toBe(keccak256(stringToBytes("q_abc")));
    expect(saltOf("q_€")).toBe(keccak256(new Uint8Array([0x71, 0x5f, 0xe2, 0x82, 0xac])));
    expect(() => saltOf("")).toThrow();
  });
});

describe("detect7702", () => {
  const delegate = "1234567890abcdef1234567890abcdef12345678";
  it.each([
    [undefined, "plain"],
    ["", "plain"],
    ["0x", "plain"],
    [`0xef0100${delegate}`, "delegated"],
    [`0xEF0100${delegate.toUpperCase()}`, "delegated"],
    [`0xef0100${delegate}00`, "contract"],
    [`0xef0100${delegate.slice(2)}`, "contract"],
    ["0xef01", "contract"],
    ["0x6080604052", "contract"],
    ["0x00", "contract"],
  ] as const)("%s => %s", (code, kind) => {
    expect(detect7702(code as never)).toBe(kind);
  });

  it("throws on malformed hex", () => {
    for (const bad of ["0x0", "ef0100", "0xzz", "0x 1"]) expect(() => detect7702(bad as never)).toThrow();
  });
});
