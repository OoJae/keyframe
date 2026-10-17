// Cross-language parity (verification.md P3): keyframe_verify derive must reproduce packages/protocol's vector
// output (which cast and the anvil EVM test also confirm), and the conformance sample must be vector 0, pure and
// deterministic (independent of clock and env).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { verifyTool } from "../src/tools/verify.js";
import { call, type Json } from "./harness/inproc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const input = JSON.parse(readFileSync(path.join(repo, "docs/design/vectors/terms-v1.input.json"), "utf8"));
const output = JSON.parse(readFileSync(path.join(repo, "packages/protocol/test/vectors/terms-v1.output.json"), "utf8"));
const sample = JSON.parse(readFileSync(path.join(here, "../paybox-plugin.json"), "utf8"));

// Two input addresses carry invalid EIP-55 checksums; case never changes the hash, so lower-case them the way
// the protocol's vector generator does. (The plugin itself rejects a bad mixed-case checksum, tested below.)
const lower = (t: Record<string, unknown>) => ({
  ...t,
  buyer: String(t.buyer).toLowerCase(),
  seller: String(t.seller).toLowerCase(),
  operator: String(t.operator).toLowerCase(),
});

describe("vector parity with packages/protocol (terms-v1)", () => {
  it.each(input.terms.map((t: Record<string, unknown>, i: number) => [i, t]) as [number, Record<string, unknown>][])(
    "terms[%i]",
    async (i, t) => {
      const r = await call(verifyTool, { mode: "derive", terms: lower(t), factory: input.factory.toLowerCase() });
      const s = r.structuredContent as Record<string, Json>;
      const want = output.terms[i];
      expect(s.terms_hash).toBe(want.termsHash);
      expect(s.escrow).toBe(want.escrow);
      expect(s.derivation.vault_impl).toBe(want.vaultImpl);
      expect(s.derivation.factory.toLowerCase()).toBe(output.factory);
    },
  );

  it("payout samples match payoutAt at due time and deadline", async () => {
    for (const sm of output.payoutSamples as { termsIndex: number; ts: number; payoutAt: string }[]) {
      const t = input.terms[sm.termsIndex];
      const s = (await call(verifyTool, { mode: "derive", terms: lower(t), factory: input.factory.toLowerCase() }))
        .structuredContent as Record<string, Json>;
      if (sm.ts === t.deadline) expect(s.payout.at_deadline).toBe(sm.payoutAt);
      if (t.dueAt === 0 || sm.ts === t.dueAt) expect(s.payout.at_due).toBe(t.amount);
    }
  });

  it("rejects a mixed-case address with a bad EIP-55 checksum instead of guessing", async () => {
    // Valid checksum is 0xabCDeF0123456789AbcdEf0123456789aBCDEF01; flip the case of one letter to break it.
    const badBuyer = "0xAbCDeF0123456789AbcdEf0123456789aBCDEF01";
    const terms = { ...input.terms[1], buyer: badBuyer };
    const r = await call(verifyTool, { mode: "derive", terms, factory: input.factory.toLowerCase() });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/terms\.buyer has an invalid EIP-55 checksum/);
  });
});

describe("conformance sample (paybox-plugin.json)", () => {
  it("is keyframe_verify derive of vector 0 and succeeds", async () => {
    expect(sample.tool).toBe("keyframe_verify");
    expect(sample.arguments.mode).toBe("derive");
    const r = await call(verifyTool, sample.arguments);
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as Record<string, Json>;
    expect(s).toMatchObject({
      mode: "derive",
      verdict: "verified",
      terms_hash: output.terms[0].termsHash,
      escrow: output.terms[0].escrow,
    });
    expect(s.onchain).toBeNull();
    expect(s.delivery).toBeNull();
  });

  it("is pure: identical output across clocks, env and network failure", async () => {
    const a = await call(verifyTool, sample.arguments);
    vi.useFakeTimers({ now: new Date("2031-01-01T00:00:00Z") });
    vi.stubEnv("KEYFRAME_FACTORIES", "not json");
    vi.stubEnv("KEYFRAME_MAINTENANCE", "1");
    vi.stubGlobal("fetch", () => {
      throw new Error("derive must not use the network");
    });
    try {
      const b = await call(verifyTool, sample.arguments);
      expect(JSON.stringify({ c: b.content, s: b.structuredContent })).toBe(
        JSON.stringify({ c: a.content, s: a.structuredContent }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags claimed hashes/addresses that do not match", async () => {
    const r = await call(verifyTool, {
      ...sample.arguments,
      escrow: "0x0000000000000000000000000000000000000001",
      terms_hash: `0x${"11".repeat(32)}`,
    });
    const s = r.structuredContent as Record<string, Json>;
    expect(s.verdict).toBe("failed");
    expect(
      s.checks
        .filter((c: Json) => c.status === "fail")
        .map((c: Json) => c.id)
        .sort(),
    ).toEqual(["claimed_escrow", "claimed_terms_hash"]);
  });
});
