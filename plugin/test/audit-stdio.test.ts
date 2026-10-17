// Bundle-level regressions of the independent plugin review over MCP stdio (dist/plugin.mjs, one process per call,
// like the PayBox sandbox): L1 (stdout stays under 256 KiB) and H2 ('changes' never yields a binding Decision).

import { hashTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decisionTypedData } from "../src/protocol/index.js";
import { quoteTool } from "../src/tools/quote.js";
import { mcp, serve } from "./harness/mcp.js";
import { BUYER, FACTORY, World } from "./harness/world.js";

let world: World;
let server: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  world = new World();
  server = await serve(world);
});
afterAll(async () => server?.close());

describe("dist/plugin.mjs regressions (stdio)", () => {
  it("L1: keyframe_styles stdout stays under 256 KiB for a < 256 KiB backend body of 1e20 literals", async () => {
    const nums = `[${Array(64).fill("1e20").join(",")}]`;
    const fmt = (i: number) =>
      `{"id":"f${i}","tier":"instant",${Array.from({ length: 38 }, (_, k) => `"k${k}":${nums}`).join(",")}}`;
    const raw = `{"formats":[${Array.from({ length: 13 }, (_, i) => fmt(i)).join(",")}]}`;
    const orig = world.handle.bind(world);
    world.handle = async (req: Request) => {
      if (new URL(req.url).pathname === "/v1/styles")
        return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
      return orig(req);
    };
    try {
      const op = await mcp("tools/call", { name: "keyframe_styles", arguments: {} }, { target: server.url });
      expect(raw.length).toBeLessThan(256 * 1024);
      expect(op.stdoutBytes).toBeLessThan(256 * 1024);
      expect(op.message.result?.resultType).toBe("complete");
    } finally {
      world.handle = orig;
    }
  });

  it("H2: decision=changes returns the plugin's own ChangeRequest, never a binding Decision", async () => {
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse({
        buyer: BUYER.address,
        format: "studio",
        rights_confirmed: true,
        params: { deliverable: "studio_sting", brief: "A forty-plus character brief for a hand-made studio sting." },
      }) as Record<string, unknown>,
    );
    world.pay(rec.quote.quote_id as string);
    world.deliverStudio(rec.quote.quote_id as string);
    world.hooks.typedData = (_td, r) => ({
      types: {
        "Decision ": [
          { name: "termsHash", type: "bytes32" },
          { name: "accept", type: "bool" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Decision ",
      domain: { name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: FACTORY },
      message: { termsHash: r.termsHash, accept: true, deadline: "99999999999" },
    });
    try {
      const op = await mcp(
        "tools/call",
        {
          name: "keyframe_review",
          arguments: { order_id: rec.orderId, access_token: rec.accessToken, decision: "changes" },
        },
        { target: server.url },
      );
      const sc = op.message.result.structuredContent;
      const td = sc.typed_data;
      expect(td.primaryType).toBe("ChangeRequest");
      const d = hashTypedData({ ...td, message: { ...td.message, deadline: BigInt(td.message.deadline) } });
      for (const accept of [true, false]) {
        expect(d).not.toBe(hashTypedData(decisionTypedData(rec.termsHash, accept, 99_999_999_999n, FACTORY)));
        expect(d).not.toBe(hashTypedData(decisionTypedData(rec.termsHash, accept, BigInt(sc.sig_deadline), FACTORY)));
      }
    } finally {
      world.hooks.typedData = undefined;
    }
  });
});
