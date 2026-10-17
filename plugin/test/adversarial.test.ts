// A hostile or broken backend must never get a proposal out of the plugin: every case returns isError, carries no
// io.paybox/transactionProposal, and says why (verification.md P6).

import { createHash } from "node:crypto";
import { type Address, getAddress, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { escrowOf, hashTerms, jcs, termsFromJson, termsToJson } from "../src/protocol/index.js";
import { commissionDirectTool, commissionTool } from "../src/tools/commission.js";
import type { ToolDef } from "../src/tools/define.js";
import { quoteTool } from "../src/tools/quote.js";
import { call, type Json, PROPOSAL, setup, stingInput } from "./harness/inproc.js";
import { ATTACKER, BUYER, FACTORY, type Hooks, OTHER_FACTORY, STRANGER, VAULT, type World } from "./harness/world.js";

/** Re-hash mutated terms so the backend is self-consistent (a competent attacker, not a typo). */
function consistent(q: Record<string, Json>, factory: Address = FACTORY, vault: Address = VAULT) {
  const t = termsFromJson(q.terms);
  q.terms = termsToJson(t);
  q.terms_hash = hashTerms(t, factory);
  q.escrow = escrowOf(q.terms_hash, factory, vault);
}

type Case = { name: string; expect: RegExp; arrange: (w: World) => void };

/** The payment input an agent holds: the quote id plus the buyer wallet and the deal hash it was shown. */
const payInput = (rec: { quote: Record<string, Json>; termsHash: string }) => ({
  quote_id: rec.quote.quote_id,
  buyer: BUYER.address,
  terms_hash: rec.quote.terms_hash ?? rec.termsHash,
});

const cases: Case[] = [
  {
    name: "402 pays an attacker instead of the escrow",
    expect: /live_402.*pays 0x/,
    arrange: (w) => {
      w.hooks.quote = (_q, rec) => {
        rec.payTo = ATTACKER;
      };
    },
  },
  {
    name: "402 asks a higher amount than the deal",
    expect: /live_402.*asks 9000000 atomic USDC/,
    arrange: (w) => {
      w.hooks.quote = (_q, rec) => {
        rec.amount = "9000000";
      };
    },
  },
  {
    name: "quote claims an escrow that is not derived from its terms",
    expect: /escrow_address/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.escrow = ATTACKER;
        rec.payTo = ATTACKER;
      };
    },
  },
  {
    name: "terms_hash does not match the terms",
    expect: /terms_hash/,
    arrange: (w) => {
      w.hooks.quote = (q) => {
        q.terms_hash = keccak256(toHex("forged"));
      };
    },
  },
  {
    name: "seller is not allowlisted (self-consistent attacker deal)",
    expect: /seller_allowlisted/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.seller = ATTACKER;
        q.spec.studio = ATTACKER;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "operator is not allowlisted",
    expect: /operator_allowlisted/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.operator = ATTACKER;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "factory is not allowlisted",
    expect: /factory_allowlisted/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        const vault = getAddress(`0x${keccak256(toHex("other-vault")).slice(-40)}`);
        q.factory = OTHER_FACTORY;
        q.vault_impl = vault;
        consistent(q, OTHER_FACTORY);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "token is not Base USDC",
    expect: /terms_valid.*not Base USDC/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.token = ATTACKER;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "amount above the plugin cap",
    expect: /amount_cap/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.amount = "60000000";
        q.price.atomic = "60000000";
        consistent(q);
        rec.payTo = q.escrow;
        rec.amount = "60000000";
      };
    },
  },
  {
    name: "price differs from the escrowed amount",
    expect: /price_matches_terms/,
    arrange: (w) => {
      w.hooks.quote = (q) => {
        q.price.atomic = "1000000";
      };
    },
  },
  {
    name: "buyer in the terms is someone else (refunds would go there)",
    expect: /buyer_matches/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.buyer = STRANGER.address;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "spec hash does not commit to the shown spec",
    expect: /spec_hash/,
    arrange: (w) => {
      w.hooks.quote = (q) => {
        q.spec.style = "something-else";
      };
    },
  },
  {
    name: "salt is not derived from the quote id",
    expect: /salt/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.salt = keccak256(toHex("reused-salt"));
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "deadline far beyond the plugin's 7-day bound",
    expect: /deadline.*7 days/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.deadline = Math.floor(Date.now() / 1000) + 20 * 86_400;
        q.deadline = q.terms.deadline;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "Instant quote that does not commit to its file",
    expect: /file_committed/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.terms.contentHash = `0x${"0".repeat(64)}`;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "preview still does not match the committed key frame",
    expect: /preview_matches_deal/,
    arrange: (w) => {
      w.hooks.quote = (q) => {
        w.files.set(new URL(q.preview.still_url).pathname, new TextEncoder().encode("a different picture"));
      };
    },
  },
  {
    name: "the committed file is not the resolution in the brief",
    expect: /file_available.*not the 16:9 size/,
    arrange: (w) => {
      w.hooks.quote = (q, rec) => {
        q.spec.aspect = "16:9";
        q.spec_hash = `0x${createHash("sha256").update(jcs(q.spec)).digest("hex")}`;
        q.terms.specHash = q.spec_hash;
        consistent(q);
        rec.payTo = q.escrow;
      };
    },
  },
  {
    name: "402 mixes x402 v1 and v2",
    expect: /live_402.*mixed_versions/,
    arrange: (w) => {
      w.hooks.payment = (wire) => {
        wire.body = JSON.stringify({ x402Version: 1, accepts: [] });
      };
    },
  },
  {
    name: "402 offers two Base USDC requirements",
    expect: /live_402.*found 2/,
    arrange: (w) => {
      w.hooks.payment = (wire) => {
        const pr = JSON.parse(atob(wire.headers["PAYMENT-REQUIRED"] as string));
        pr.accepts.push({ ...pr.accepts[0], payTo: ATTACKER });
        wire.headers["PAYMENT-REQUIRED"] = btoa(JSON.stringify(pr));
      };
    },
  },
  {
    name: "402 on the wrong network",
    expect: /live_402.*found 0/,
    arrange: (w) => {
      w.hooks.payment = (wire) => {
        const pr = JSON.parse(atob(wire.headers["PAYMENT-REQUIRED"] as string));
        pr.accepts[0].network = "eip155:1";
        wire.headers["PAYMENT-REQUIRED"] = btoa(JSON.stringify(pr));
      };
    },
  },
  {
    name: "402 with a non-exact scheme",
    expect: /live_402.*found 0/,
    arrange: (w) => {
      w.hooks.payment = (wire) => {
        const pr = JSON.parse(atob(wire.headers["PAYMENT-REQUIRED"] as string));
        pr.accepts[0].scheme = "upto";
        wire.headers["PAYMENT-REQUIRED"] = btoa(JSON.stringify(pr));
      };
    },
  },
  {
    name: "402 in another asset",
    expect: /live_402.*found 0/,
    arrange: (w) => {
      w.hooks.payment = (wire) => {
        const pr = JSON.parse(atob(wire.headers["PAYMENT-REQUIRED"] as string));
        pr.accepts[0].asset = ATTACKER;
        wire.headers["PAYMENT-REQUIRED"] = btoa(JSON.stringify(pr));
      };
    },
  },
  {
    name: "escrow already holds the money (paid by another route)",
    expect: /escrow_unused.*looks paid/,
    arrange: (w) => {
      w.hooks.quote = (q) => {
        w.usdc.set(String(q.escrow).toLowerCase(), 4_000_000n);
      };
    },
  },
  {
    name: "deal already registered on-chain",
    expect: /escrow_unused.*already Open/,
    arrange: (w) => {
      w.hooks.quote = (_q, rec) => {
        queueMicrotask(() => w.setOrder(rec.quote.quote_id as string, { status: 1 }));
      };
    },
  },
  {
    name: "one of two RPCs reports the escrow as already funded",
    expect: /escrow_unused/,
    arrange: (w) => {
      w.hooks.rpc = (host, method, params, result) => {
        if (
          host === "rpc2.kf.test" &&
          method === "eth_call" &&
          String((params[0] as { data: string }).data).startsWith("0x70a08231")
        ) {
          const who = String((params[0] as { data: string }).data).slice(-40);
          const rec = [...w.quotes.values()][0];
          if (rec?.escrow.toLowerCase().endsWith(who)) return `0x${4_000_000n.toString(16).padStart(64, "0")}`;
        }
        return result;
      };
    },
  },
];

async function quoteThenPay(world: World, tool: ToolDef) {
  const hooks: Hooks = { ...world.hooks };
  world.hooks = {};
  const rec = await world.createQuote(
    quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
  );
  world.hooks = hooks;
  hooks.quote?.(rec.quote, rec);
  await new Promise((r) => setTimeout(r, 0));
  return call(tool, payInput(rec));
}

describe.each([commissionTool, commissionDirectTool])("$name refuses hostile backends", (tool) => {
  it.each(cases)("$name", async (c) => {
    const world = setup();
    c.arrange(world);
    const r = await quoteThenPay(world, tool);
    expect(r.isError, r.text).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(PROPOSAL);
    expect(r.text).toMatch(c.expect);
    expect(r.text).toContain("Nothing was proposed");
  });

  it.each([
    ["paid", /already paid/],
    ["expired", /expired; request a new quote/],
    ["cancelled", /cancelled; request a new quote/],
    ["draft", /not final yet/],
  ])("refuses a %s quote", async (status, expected) => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    rec.quote.status = status;
    rec.draftPolls = 99;
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(expected);
    expect(JSON.stringify(r)).not.toContain(PROPOSAL);
  });

  it("refuses a quote about to expire", async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    rec.quote.quote_expires_at = Math.floor(Date.now() / 1000) + 30;
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expires in under 90 seconds/);
  });

  it("refuses an unknown quote and a malformed quote", async () => {
    const world = setup();
    expect(
      (
        await call(tool, {
          quote_id: "q_1111111111111111111111",
          buyer: BUYER.address,
          terms_hash: `0x${"11".repeat(32)}`,
        })
      ).text,
    ).toMatch(/HTTP 404/);
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    delete rec.quote.terms;
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not match the frozen v1 format \(at "terms"\)/);
  });

  it("refuses when the payment URL already reports paid (HTTP 409)", async () => {
    const world = setup();
    world.hooks.payment = (wire) => {
      wire.status = 409;
    };
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already paid/);
  });

  it("refuses when nothing is configured (fail-closed defaults)", async () => {
    const world = setup({ KEYFRAME_FACTORIES: "", KEYFRAME_SELLERS: "", KEYFRAME_OPERATORS: "" });
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/factory_allowlisted/);
    expect(r.text).toMatch(/seller_allowlisted/);
  });

  it("refuses in maintenance mode, and when the maintenance switch is unreadable", async () => {
    for (const value of ["1", "yes"]) {
      const world = setup({ KEYFRAME_MAINTENANCE: value });
      const rec = await world.createQuote(
        quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
      );
      const r = await call(tool, payInput(rec));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/paused for maintenance/);
    }
  });

  it("fails soft within budget when the API host hangs (slow host)", async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    world.delays.set("api.kf.test", 6_000);
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/);
    expect(r.ms).toBeLessThan(4_500);
  });

  it("refuses when the 402 probe hangs, within the 8.5 s tool budget", async () => {
    const world = setup();
    const rec = await world.createQuote(
      quoteTool.inputSchema.parse(stingInput(BUYER.address)) as Record<string, unknown>,
    );
    world.hooks.payment = () => undefined;
    const orig = world.handle.bind(world);
    world.handle = async (req) => {
      if (new URL(req.url).pathname.startsWith("/v1/orders/")) await new Promise((r) => setTimeout(r, 6_000));
      return orig(req);
    };
    const r = await call(tool, payInput(rec));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/live_402.*timed out/);
    expect(r.ms).toBeLessThan(8_500);
  });
});
