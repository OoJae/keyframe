// The plugin against the REAL KeyframeEscrowFactory bytecode (contracts/out, read-only) on a local anvil chain
// (chain id 8453, no fork, no network). It proves on an actual EVM that: the plugin's termsHash/escrow equal the
// contract's; its order() decoding matches the real ABI; its refund / sweep / reject proposals execute and pay the
// buyer; its canonical Decision typed data is accepted by decideBySig; and keyframe_verify delivery decrypts a file
// with the key the contract really published. Skips itself when anvil or the artifacts are unavailable.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  keccak256,
  toHex,
  zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionPayload } from "../src/core/typed.js";
import {
  DECISION_TYPES,
  encryptKfc1,
  erc20Abi,
  escrowOf,
  hashTerms,
  keyframeFactoryAbi,
  keyHashOf,
  saltOf,
  type Terms,
  termsToJson,
  USDC,
  vaultImplOf,
} from "../src/protocol/index.js";
import { refundTool } from "../src/tools/refund.js";
import { verifyTool } from "../src/tools/verify.js";
import { call, type Json, PROPOSAL } from "./harness/inproc.js";
import { MP4 } from "./harness/world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../contracts/out");
const FACTORY_ARTIFACT = path.join(OUT, "KeyframeEscrowFactory.sol/KeyframeEscrowFactory.json");
const USDC_ARTIFACT = path.join(OUT, "MockUSDC.sol/MockUSDC.json");

function artifact(file: string): Hex | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { bytecode?: { object?: string } };
    const code = j.bytecode?.object;
    return typeof code === "string" && /^0x[0-9a-fA-F]{100,}$/.test(code) ? (code as Hex) : null;
  } catch {
    return null;
  }
}
const factoryCode = existsSync(FACTORY_ARTIFACT) ? artifact(FACTORY_ARTIFACT) : null;
const usdcCode = existsSync(USDC_ARTIFACT) ? artifact(USDC_ARTIFACT) : null;
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const realFetch = globalThis.fetch;
const ready = hasAnvil && factoryCode !== null && usdcCode !== null;

// The standard public anvil test mnemonic (local test accounts, never real funds).
const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const BUYER = acct(0);
const DEPLOYER = acct(1);
const STRANGER = acct(3);
const OPERATOR = acct(4);
const SELLER = acct(5);
const base = {
  id: 8453,
  name: "base-local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] as string[] } },
} as const;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

describe.skipIf(!ready)("plugin x real KeyframeEscrowFactory on anvil", () => {
  let anvil: ReturnType<typeof spawn>;
  let rpc: string;
  let pub: ReturnType<typeof createPublicClient>;
  let test: ReturnType<typeof createTestClient>;
  let factory: Address;
  const files = new Map<string, Uint8Array>();
  let chainOffset = 0;

  const wallet = (a: ReturnType<typeof acct>) =>
    createWalletClient({ account: a, chain: base, transport: http(rpc), pollingInterval: 50 });
  const send = async (a: ReturnType<typeof acct>, to: Address, data: Hex) => {
    const hash = await wallet(a).sendTransaction({ to, data, value: 0n });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.status;
  };
  const usdcBal = (who: Address) =>
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const tuple = (t: Terms) => ({ ...t, dueAt: BigInt(t.dueAt), deadline: BigInt(t.deadline) });
  const chainNow = async () => Number((await pub.getBlock()).timestamp);
  const warp = async (seconds: number) => {
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
    chainOffset += seconds;
  };
  /** Plugin calls see wall time shifted by the chain warp (only Date is faked, only during the call). */
  const at = async <T>(run: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + chainOffset * 1000 });
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
  };

  async function newTerms(over: Partial<Terms> & { quote: string; key: Hex }): Promise<Terms> {
    const { quote, key, ...rest } = over;
    return {
      buyer: BUYER.address,
      seller: SELLER.address,
      operator: OPERATOR.address,
      token: USDC,
      amount: 1_000_000n,
      dueAt: 0,
      deadline: (await chainNow()) + 600,
      reviewWindow: 0,
      slaFloorBps: 10_000,
      killFeeBps: 0,
      keyHash: keyHashOf(key),
      specHash: keccak256(toHex(`spec:${quote}`)),
      contentHash: keccak256(toHex(`content:${quote}`)),
      salt: saltOf(quote),
      ...rest,
    };
  }

  async function fundAndRegister(t: Terms) {
    const E = escrowOf(hashTerms(t, factory), factory);
    expect(
      await send(BUYER, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [E, t.amount] })),
    ).toBe("success");
    expect(
      await send(
        STRANGER,
        factory,
        encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "register", args: [tuple(t)] }),
      ),
    ).toBe("success");
    return E;
  }

  type Tx = { to: Address; data: Hex; value: string };
  const proposal = (r: { structuredContent?: Record<string, unknown> }): Tx =>
    (r.structuredContent as Record<string, { transaction: Tx }>)[PROPOSAL]?.transaction as Tx;

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--mnemonic", MNEMONIC], {
      stdio: "ignore",
    });
    pub = createPublicClient({ chain: base, transport: http(rpc), pollingInterval: 50 });
    test = createTestClient({ mode: "anvil", chain: base, transport: http(rpc), pollingInterval: 50 });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Mock USDC at the canonical Base USDC address (the plugin and factory both require token == USDC).
    const usdcTx = await wallet(DEPLOYER).deployContract({ abi: [], bytecode: usdcCode as Hex });
    const usdcAt = (await pub.waitForTransactionReceipt({ hash: usdcTx })).contractAddress as Address;
    await test.setCode({ address: USDC, bytecode: (await pub.getCode({ address: usdcAt })) as Hex });
    await send(
      DEPLOYER,
      USDC,
      encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "mint",
            stateMutability: "nonpayable",
            inputs: [
              { name: "to", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [],
          },
        ],
        functionName: "mint",
        args: [BUYER.address, 100_000_000n],
      }),
    );
    const ctor = encodeAbiParameters([{ type: "address" }, { type: "address" }], [USDC, SELLER.address]);
    const fTx = await wallet(acct(2)).sendTransaction({ data: `${factoryCode}${ctor.slice(2)}` as Hex });
    factory = getAddress((await pub.waitForTransactionReceipt({ hash: fTx })).contractAddress as Address);
  }, 60_000);

  // unstubEnvs/unstubGlobals reset these after every test, so they are re-applied per test.
  beforeEach(() => {
    // Plugin env: two "RPCs" (the same anvil), the real factory allowlisted, the file host served from memory.
    const env: Record<string, string> = {
      KEYFRAME_API_BASE: "https://api.kf.test",
      KEYFRAME_FILES_BASE: "https://files.kf.test",
      KEYFRAME_RPC_URLS: "https://anvil-a.kf.test,https://anvil-b.kf.test",
      KEYFRAME_FACTORIES: JSON.stringify([{ address: factory, vaultImpl: vaultImplOf(factory), status: "active" }]),
      KEYFRAME_SELLERS: SELLER.address,
      KEYFRAME_OPERATORS: OPERATOR.address,
      KEYFRAME_IPFS_GATEWAY: "off",
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.hostname === "127.0.0.1") return realFetch(input, init); // this test's own viem clients
      if (u.host.startsWith("anvil-")) return realFetch(rpc, init);
      if (u.host === "files.kf.test") {
        const f = files.get(u.pathname);
        return f ? new Response(f.slice(), { status: 200 }) : new Response("nf", { status: 404 });
      }
      throw new TypeError("fetch failed", { cause: new Error("blocked") });
    });
  });

  afterAll(() => {
    anvil?.kill("SIGKILL");
  });

  it("the plugin's derivation equals the deployed factory's (hashTerms, escrowOf, VAULT_IMPL)", async () => {
    const t = await newTerms({ quote: "q_derivation", key: `0x${"01".repeat(32)}` });
    const r = await at(() => call(verifyTool, { mode: "derive", terms: termsToJson(t), factory }));
    const s = r.structuredContent as Record<string, Json>;
    expect(s.terms_hash).toBe(
      await pub.readContract({
        address: factory,
        abi: keyframeFactoryAbi,
        functionName: "hashTerms",
        args: [tuple(t)],
      }),
    );
    expect(s.escrow).toBe(
      await pub.readContract({
        address: factory,
        abi: keyframeFactoryAbi,
        functionName: "escrowOf",
        args: [s.terms_hash],
      }),
    );
    expect(s.derivation.vault_impl).toBe(
      getAddress(await pub.readContract({ address: factory, abi: keyframeFactoryAbi, functionName: "VAULT_IMPL" })),
    );
  });

  it("direct-rail funding + register, verified by the plugin; refund refused early, then executed by a stranger", async () => {
    const t = await newTerms({ quote: "q_refundflow", key: `0x${"02".repeat(32)}` });
    const E = await fundAndRegister(t);
    const before = await usdcBal(BUYER.address);
    let s = (await at(() => call(verifyTool, { mode: "funding", terms: termsToJson(t), factory })))
      .structuredContent as Record<string, Json>;
    expect(s).toMatchObject({ verdict: "verified", envelope: "SEALED", escrow: E });
    expect(s.onchain).toMatchObject({ status: "Open", escrow_code: "none", escrow_balance_atomic: "1000000" });

    const early = await at(() => call(refundTool, { action: "refund", terms: termsToJson(t), factory }));
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/Not refundable yet/);

    await warp(700);
    const r = await at(() => call(refundTool, { action: "refund", terms: termsToJson(t), factory }));
    expect(r.isError, r.text).toBeUndefined();
    const tx = proposal(r);
    expect(tx.to).toBe(factory);
    expect(await send(STRANGER, tx.to, tx.data)).toBe("success");
    expect(await usdcBal(BUYER.address)).toBe(before + t.amount);

    s = (await at(() => call(verifyTool, { mode: "funding", terms: termsToJson(t), factory })))
      .structuredContent as Record<string, Json>;
    expect(s).toMatchObject({ verdict: "verified", envelope: "RETURNED" });
    expect(s.onchain).toMatchObject({
      status: "Refunded",
      escrow_code: "eip1167",
      to_buyer_atomic: "1000000",
      to_seller_atomic: "0",
    });

    // Late funds after the refund: sweep returns them to the buyer, never anyone else.
    await send(BUYER, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [E, 250_000n] }));
    const sw = await at(() => call(refundTool, { action: "sweep", terms: termsToJson(t), factory }));
    expect(sw.isError, sw.text).toBeUndefined();
    const mid = await usdcBal(BUYER.address);
    expect(await send(STRANGER, proposal(sw).to, proposal(sw).data)).toBe("success");
    expect(await usdcBal(BUYER.address)).toBe(mid + 250_000n);
    expect(
      (await at(() => call(refundTool, { action: "sweep", terms: termsToJson(t), factory, token: zeroAddress }))).text,
    ).toMatch(/holds none/);
  });

  it("Studio: the plugin's canonical Decision typed data is accepted by decideBySig; reject proposal executes", async () => {
    const t = await newTerms({
      quote: "q_studioflow",
      key: `0x${"03".repeat(32)}`,
      reviewWindow: 3_600,
      killFeeBps: 2_000,
      contentHash: `0x${"0".repeat(64)}`,
    });
    await fundAndRegister(t);
    const h = hashTerms(t, factory);
    await send(
      OPERATOR,
      factory,
      encodeFunctionData({
        abi: keyframeFactoryAbi,
        functionName: "deliver",
        args: [tuple(t), keccak256(toHex("studio-master"))],
      }),
    );

    // Accept by signature (what keyframe_review stage 1 hands to request_wallet_sign).
    const deadline = (await chainNow()) + 900;
    const td = decisionPayload(factory, h, true, deadline);
    const sig = await BUYER.signTypedData({
      domain: td.domain,
      types: DECISION_TYPES,
      primaryType: "Decision",
      message: { termsHash: h, accept: true, deadline: BigInt(deadline) },
    });
    expect(
      await send(
        STRANGER,
        factory,
        encodeFunctionData({
          abi: keyframeFactoryAbi,
          functionName: "decideBySig",
          args: [tuple(t), true, BigInt(deadline), sig],
        }),
      ),
    ).toBe("success");
    const o = await pub.readContract({ address: factory, abi: keyframeFactoryAbi, functionName: "order", args: [h] });
    expect(o.accepted).toBe(true);

    // A second Studio order: buyer rejects via the plugin's decide(T, false) proposal; kill fee to the seller.
    const t2 = await newTerms({
      quote: "q_studioreject",
      key: `0x${"04".repeat(32)}`,
      reviewWindow: 3_600,
      killFeeBps: 2_000,
      contentHash: `0x${"0".repeat(64)}`,
    });
    await fundAndRegister(t2);
    await send(
      OPERATOR,
      factory,
      encodeFunctionData({
        abi: keyframeFactoryAbi,
        functionName: "deliver",
        args: [tuple(t2), keccak256(toHex("studio-master-2"))],
      }),
    );
    const r = await at(() => call(refundTool, { action: "reject", terms: termsToJson(t2), factory }));
    expect(r.isError, r.text).toBeUndefined();
    const sellerBefore = await usdcBal(SELLER.address);
    expect(await send(BUYER, proposal(r).to, proposal(r).data)).toBe("success");
    expect(await usdcBal(SELLER.address)).toBe(sellerBefore + 200_000n);
    const s = (await at(() => call(verifyTool, { mode: "funding", terms: termsToJson(t2), factory })))
      .structuredContent as Record<string, Json>;
    expect(s.onchain.status).toBe("Rejected");
    expect(s.envelope).toBe("RETURNED");
  });

  it("Instant: release on-chain publishes the key; keyframe_verify delivery decrypts the real file with it", async () => {
    const quote = "q_releaseflow";
    const kChain = keccak256(toHex("anvil-kchain")) as Hex;
    const plaintext = new Uint8Array(1_200_000);
    plaintext.set(MP4);
    const enc = await encryptKfc1(plaintext, {
      kChain,
      kBuyer: `0x${"0".repeat(64)}`,
      salt: saltOf(quote),
      media: { mime: "video/mp4", width: 1080, height: 1920, durationMs: 6000, fps: 30 },
    });
    files.set(`/c/${enc.manifestHash}/manifest.json`, new TextEncoder().encode(JSON.stringify(enc.manifest)));
    for (const [i, c] of enc.chunks.entries()) files.set(`/c/${enc.manifestHash}/${i}.bin`, c);
    const t = await newTerms({ quote, key: kChain, contentHash: enc.manifestHash });
    const E = await fundAndRegister(t);

    let s = (await at(() => call(verifyTool, { mode: "delivery", terms: termsToJson(t), factory })))
      .structuredContent as Record<string, Json>;
    expect(s.checks.find((c: Json) => c.id === "key_published").detail).toMatch(/not delivered yet: SEALED/);

    const sellerBefore = await usdcBal(SELLER.address);
    expect(
      await send(
        OPERATOR,
        factory,
        encodeFunctionData({
          abi: keyframeFactoryAbi,
          functionName: "release",
          args: [tuple(t), kChain, t.amount, enc.manifestHash],
        }),
      ),
    ).toBe("success");
    expect(await usdcBal(SELLER.address)).toBe(sellerBefore + t.amount);

    s = (await at(() => call(verifyTool, { mode: "delivery", terms: termsToJson(t), factory })))
      .structuredContent as Record<string, Json>;
    expect(s, JSON.stringify(s.checks)).toMatchObject({ envelope: "KEY PUBLISHED", escrow: E });
    for (const id of [
      "key_published",
      "key_matches_deal",
      "file_matches_deal",
      "manifest",
      "decrypts",
      "file_fingerprint",
      "video_header",
    ]) {
      expect(s.checks.find((c: Json) => c.id === id)?.status, id).toBe("pass");
    }
    expect(s.delivery).toMatchObject({
      chunks_total: 2,
      chunks_verified: 2,
      media: { width: 1080, height: 1920, duration_ms: 6000 },
    });
    // No spec without the API: the verdict is partial only because the brief could not be compared.
    expect(s.checks.filter((c: Json) => c.status === "skip").map((c: Json) => c.id)).toEqual(["matches_brief"]);
    expect(chainOffset).toBeGreaterThan(0);
  });
});
