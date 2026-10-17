// P5 at the plugin level (the live-402 check never throws, whatever the server sends) and P11 (every tool answers
// inside the 8.5 s budget even when every host hangs, and money tools never propose under those conditions).

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { Budget } from "../src/core/net.js";
import { probe402 } from "../src/core/probe.js";
import { TOOLS } from "../src/tools/index.js";
import { call, PROPOSAL, setup, stingInput } from "./harness/inproc.js";
import { ATTACKER, BUYER, HOSTS } from "./harness/world.js";

describe("live 402 check under arbitrary server responses (fuzz)", () => {
  it("returns a pass/fail check and never throws", async () => {
    const cfg = loadConfig({ KEYFRAME_API_BASE: HOSTS.api });
    const header = fc.oneof(
      fc.string(),
      fc.base64String(),
      fc.jsonValue().map((v) => btoa(unescape(encodeURIComponent(JSON.stringify(v))))),
      fc
        .record({
          x402Version: fc.constantFrom(1, 2, 3),
          accepts: fc.array(fc.dictionary(fc.string(), fc.jsonValue()), { maxLength: 3 }),
        })
        .map((v) => btoa(JSON.stringify(v))),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(200, 301, 402, 409, 500),
        fc.option(header),
        fc.option(fc.string({ maxLength: 300 })),
        async (status, h, body) => {
          vi.stubGlobal(
            "fetch",
            async () =>
              new Response(status === 301 ? null : (body ?? null), {
                status,
                headers: h == null ? {} : { "PAYMENT-REQUIRED": h },
              }),
          );
          const r = await probe402(cfg, new Budget(), "q_1111111111111111111111", {
            escrow: ATTACKER,
            amount: 4_000_000n,
          });
          return ["pass", "fail"].includes(r.check.status) && (r.ok === false || r.check.status === "pass");
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("every tool stays inside the 8.5 s budget when all hosts hang (6 s)", () => {
  it("answers in time; money tools return no proposal", async () => {
    const world = setup();
    const rec = await world.createQuote({ ...stingInput(BUYER.address), aspect: "9:16", deadline_minutes: 30 });
    for (const h of ["api.kf.test", "files.kf.test", "rpc1.kf.test", "rpc2.kf.test"]) world.delays.set(h, 6_000);
    const qid = rec.quote.quote_id as string;
    const inputs: Record<string, unknown> = {
      keyframe_styles: {},
      keyframe_quote: stingInput(BUYER.address),
      keyframe_commission: { quote_id: qid, buyer: BUYER.address, terms_hash: rec.termsHash },
      keyframe_commission_direct: { quote_id: qid, buyer: BUYER.address, terms_hash: rec.termsHash },
      keyframe_status: { order_id: rec.orderId, wait_s: 6 },
      keyframe_verify: { mode: "delivery", terms: rec.quote.terms, factory: rec.quote.factory },
      keyframe_refund: { action: "refund", terms: rec.quote.terms, factory: rec.quote.factory },
      keyframe_review: { order_id: rec.orderId, access_token: rec.accessToken, decision: "accept" },
      keyframe_orders: { address: BUYER.address },
    };
    const results = await Promise.all(TOOLS.map(async (t) => ({ name: t.name, r: await call(t, inputs[t.name]) })));
    for (const { name, r } of results) {
      expect(r.ms, name).toBeLessThan(8_500);
      expect(JSON.stringify(r).includes(PROPOSAL), name).toBe(false);
    }
    expect(results.find((x) => x.name === "keyframe_styles")?.r.structuredContent?.source).toBe("embedded");
  }, 30_000);
});
