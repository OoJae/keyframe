import { existsSync } from "node:fs";
import { join } from "node:path";
import { vaultImplOf } from "@keyframe/protocol";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anvilAvailable, chainHarness, type LocalChain, startLocalChain } from "./support/anvil.js";
import { type Json, PUBLIC_BASE } from "./support/harness.js";

// Frozen-interface conformance from the consumer's side: the plugin's own tool handlers (plugin/src/tools, the
// code that will be uploaded) run against this API and the real contracts on a local anvil. The plugin's fetches
// are routed in-process: API and files host → this Hono app; its RPC host → anvil. Skips when the plugin sources
// or Foundry are not present.

const PLUGIN = join(import.meta.dirname, "../../../plugin/src/tools/index.ts");
// Two RPC hosts (both → the same anvil) so the plugin's cross-RPC check has two answers to compare.
const RPC_HOSTS = ["https://rpc-a.keyframe.test", "https://rpc-b.keyframe.test"];

type ToolResult = { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Tool = { inputSchema: { parse(x: unknown): unknown }; handler(i: unknown): Promise<ToolResult> };
type Check = { id: string; status: string; detail: string };

const failures = (r: ToolResult) =>
  ((r.structuredContent?.checks as Check[] | undefined) ?? []).filter((c) => c.status === "fail");

// plugin/ is its own pnpm root: its sources resolve viem/zod from plugin/node_modules.
const pluginReady = existsSync(PLUGIN) && existsSync(join(import.meta.dirname, "../../../plugin/node_modules/viem"));

describe.runIf(anvilAvailable() && pluginReady)("plugin ⇄ API ⇄ contracts (frozen v1)", () => {
  let c: LocalChain;
  let tools: Record<string, Tool>;
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    c = await startLocalChain();
    const mod = (await import(PLUGIN)) as { TOOLS: readonly (Tool & { name: string })[] };
    tools = Object.fromEntries(mod.TOOLS.map((t) => [t.name, t]));
  }, 120_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    process.env = savedEnv;
    c?.stop();
  });

  const call = async (name: string, input: unknown) => {
    const tool = tools[name];
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.handler(tool.inputSchema.parse(input));
  };

  /** Point the plugin at this API + the local chain and route its fetches in-process. */
  function wire(h: Awaited<ReturnType<typeof chainHarness>>["h"]) {
    const operator = privateKeyToAccount(c.operatorKey).address;
    Object.assign(process.env, {
      KEYFRAME_API_BASE: PUBLIC_BASE,
      KEYFRAME_FILES_BASE: `${PUBLIC_BASE}/files`,
      KEYFRAME_RPC_URLS: RPC_HOSTS.join(","),
      KEYFRAME_IPFS_GATEWAY: "off",
      KEYFRAME_FACTORIES: JSON.stringify([{ address: c.factory, vaultImpl: vaultImplOf(c.factory), status: "active" }]),
      KEYFRAME_SELLERS: c.seller,
      KEYFRAME_OPERATORS: operator,
      KEYFRAME_MAX_AMOUNT: "50000000",
      KEYFRAME_PRIMARY_RAIL: "x402",
      KEYFRAME_MAINTENANCE: "0",
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${PUBLIC_BASE}/`)) return h.request(url.slice(PUBLIC_BASE.length), init);
      if (RPC_HOSTS.some((r) => url.startsWith(r))) return realFetch(c.rpc, init);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init); // the API's own viem client → anvil
      throw new TypeError(`test network: blocked ${url}`);
    }) as typeof fetch;
  }

  /** Payment tool input: quote_id plus the buyer and terms_hash the agent got from keyframe_quote (plugin ≥ fix). */
  async function commissionInput(h: Awaited<ReturnType<typeof chainHarness>>["h"], quoteId: string) {
    const q = (await (await h.request(`/v1/quotes/${quoteId}`)).json()) as Json;
    return { quote_id: quoteId, buyer: q.buyer, terms_hash: q.terms_hash };
  }

  /** Sign plugin-returned eth_signTypedData_v4 JSON the way a wallet would. */
  async function signTyped(account: { signTypedData: (a: never) => Promise<string> }, td: Json) {
    const { EIP712Domain: _, ...types } = td.types;
    const message = { ...td.message, deadline: BigInt(td.message.deadline) };
    return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message } as never);
  }

  it("Studio: commission → deliver → keyframe_review changes + accept → released → verify delivery", async () => {
    const { h, buyer } = await chainHarness(c);
    wire(h);
    const quoted = await call("keyframe_quote", {
      buyer: buyer.address,
      format: "studio",
      rights_confirmed: true,
      params: {
        deliverable: "studio_sting",
        brief: "A confident ten second sting for a parachute-themed DeFi safety brand.",
      },
    });
    expect(quoted.isError, quoted.content[0]?.text).toBeFalsy();
    expect(failures(quoted)).toEqual([]);
    const quoteId = JSON.stringify(quoted.structuredContent).match(/q_[1-9A-HJ-NP-Za-km-z]{22}/)?.[0] as string;
    const commission = await call("keyframe_commission", await commissionInput(h, quoteId));
    expect(commission.isError, commission.content[0]?.text).toBeFalsy();
    const paid = await (await h.pay(quoteId, await h.paymentHeaders(quoteId))).json();
    await h.drain();
    await h.deliverStudio(paid.order_id);
    const ref = { order_id: paid.order_id, access_token: paid.access_token };

    // changes: the plugin validates our ChangeRequest typed data, the buyer signs, the API records it
    const ch1 = await call("keyframe_review", { ...ref, decision: "changes" });
    expect(ch1.isError, ch1.content[0]?.text).toBeFalsy();
    const td1 = ch1.structuredContent?.typed_data as Json;
    expect(td1.primaryType).toBe("ChangeRequest");
    const sub1 = await call("keyframe_review", {
      ...ref,
      decision: "changes",
      signature: await signTyped(buyer as never, td1),
      ...(ch1.structuredContent?.sig_deadline ? { sig_deadline: ch1.structuredContent.sig_deadline } : {}),
    });
    expect(sub1.isError, sub1.content[0]?.text).toBeFalsy();

    // accept: Decision typed data rebuilt by the plugin, signature relayed via decideBySig
    const ch2 = await call("keyframe_review", { ...ref, decision: "accept" });
    expect(ch2.isError, ch2.content[0]?.text).toBeFalsy();
    const td2 = ch2.structuredContent?.typed_data as Json;
    const sub2 = await call("keyframe_review", {
      ...ref,
      decision: "accept",
      signature: await signTyped(buyer as never, td2),
      sig_deadline: ch2.structuredContent?.sig_deadline,
    });
    expect(sub2.isError, sub2.content[0]?.text).toBeFalsy();
    expect(sub2.structuredContent?.tx).toMatch(/^0x[0-9a-f]{64}$/);
    await h.drain();

    const delivery = await call("keyframe_verify", { mode: "delivery", ...ref });
    const notPass = ((delivery.structuredContent?.checks as Check[]) ?? []).filter((x) => x.status !== "pass");
    expect(delivery.structuredContent?.verdict, JSON.stringify(notPass)).toBe("verified");
  });

  it("quote → status → commission (x402 proposal) → pay → verify funding → verify delivery", async () => {
    const { h, buyer } = await chainHarness(c);
    wire(h);

    // 1. keyframe_quote: the plugin posts its own input; an Instant quote comes back as a draft
    const quoted = await call("keyframe_quote", {
      buyer: buyer.address,
      format: "countdown",
      rights_confirmed: true,
      params: { style: "tminus", label: "Mainnet", target: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(quoted.isError, quoted.content[0]?.text).toBeFalsy();
    expect(failures(quoted)).toEqual([]);
    const quoteId = (quoted.structuredContent?.quote_id ??
      JSON.stringify(quoted.structuredContent).match(/q_[1-9A-HJ-NP-Za-km-z]{22}/)?.[0]) as string;
    expect(quoteId).toMatch(/^q_/);

    // render-before-pay: the worker turns it final
    const { done } = await h.render();
    expect(done?.status).toBe(200);

    // 2. keyframe_status on the quote: the plugin re-checks everything live (402, chain, still, manifest)
    const status = await call("keyframe_status", { quote_id: quoteId });
    expect(status.isError, status.content[0]?.text).toBeFalsy();

    // 3. keyframe_commission: every independent check passes and an x402 proposal is produced
    const commission = await call("keyframe_commission", await commissionInput(h, quoteId));
    expect(commission.isError, commission.content[0]?.text).toBeFalsy();
    const proposal = commission.structuredContent?.["io.paybox/transactionProposal"] as Record<string, unknown>;
    expect(proposal).toBeTruthy();
    expect(JSON.stringify(proposal)).toContain(`${PUBLIC_BASE}/v1/orders/${quoteId}`);
    expect(JSON.stringify(proposal)).toContain("1000000");

    // 4. PayBox pays the 402 (same x402 libraries); 200 paid body
    const paid = await h.pay(quoteId, await h.paymentHeaders(quoteId));
    expect(paid.status).toBe(200);
    const body = await paid.json();
    await h.drain();

    // 5. keyframe_verify funding and delivery: proven from chain + public storage, file decrypted by the plugin
    const funding = await call("keyframe_verify", { mode: "funding", paid_response: body });
    expect(funding.isError, funding.content[0]?.text).toBeFalsy();
    expect(failures(funding)).toEqual([]);
    const delivery = await call("keyframe_verify", { mode: "delivery", paid_response: body });
    expect(delivery.isError, delivery.content[0]?.text).toBeFalsy();
    expect(failures(delivery), delivery.content[0]?.text).toEqual([]);
    const notPass = ((delivery.structuredContent?.checks as Check[]) ?? []).filter((x) => x.status !== "pass");
    expect(delivery.structuredContent?.verdict, JSON.stringify(notPass)).toBe("verified");

    // 6. keyframe_orders: SIWE recovery through the plugin's strict EIP-4361 check
    const signIn = await call("keyframe_orders", { address: buyer.address });
    expect(signIn.isError, signIn.content[0]?.text).toBeFalsy();
    const message = signIn.structuredContent?.message as string;
    const signature = await buyer.signMessage({ message });
    const recovered = await call("keyframe_orders", { address: buyer.address, message, signature });
    expect(recovered.isError, recovered.content[0]?.text).toBeFalsy();
    const orders = recovered.structuredContent?.orders as { order_id: string; access_token: string }[];
    expect(orders.map((o) => o.order_id)).toEqual([body.order_id]);
    expect(orders[0]?.access_token).toBe(body.access_token);
  });
});
