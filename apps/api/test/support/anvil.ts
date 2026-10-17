import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { USDC } from "@keyframe/protocol";
import type { LocalAccount } from "viem";
import {
  type Address,
  bytesToHex,
  type Chain,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  type PublicClient,
} from "viem";
import { english, generateMnemonic, generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { viemChainReader } from "../../src/chain.js";
import { RelayerCore, type RelayerStore, type StoredTx } from "../../src/relayer/core.js";
import type { RelayerClient } from "../../src/relayer/types.js";
import { Harness } from "./harness.js";

// A throwaway local EVM for end-to-end tests: anvil with chain id 8453 (no fork, no network), the real escrow
// factory built from contracts/src, and the test USDC mock installed AT the canonical Base USDC address, so the
// API runs with production constants (no USDC override). Keys come from a random mnemonic per run.

const E2E = join(import.meta.dirname, "../e2e");
const CONTRACTS = join(import.meta.dirname, "../../../../contracts/src/KeyframeEscrowFactory.sol");

const has = (bin: string) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export const anvilAvailable = (): boolean =>
  process.env.KEYFRAME_E2E !== "0" && has("anvil") && has("forge") && existsSync(CONTRACTS);

const artifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(join(E2E, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

const MINT_ABI = [
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
] as const;

export interface LocalChain {
  rpc: string;
  pub: PublicClient;
  factory: Address;
  seller: Address;
  operatorKey: Hex;
  mnemonic: string;
  mint(to: Address, amount: bigint): Promise<void>;
  balance(a: Address): Promise<bigint>;
  /** viem chain object pointing at this anvil (for wallet clients in tests). */
  chain: Chain;
  stop(): void;
}

export async function startLocalChain(): Promise<LocalChain> {
  // test/global-setup.ts builds once per run; build here only when used standalone.
  if (!existsSync(join(E2E, "out", "E2E.sol"))) execFileSync("forge", ["build", "--root", E2E], { stdio: "ignore" });
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const mnemonic = generateMnemonic(english);
  const proc: ChildProcess = spawn(
    "anvil",
    ["--port", String(port), "--chain-id", "8453", "--mnemonic", mnemonic, "--silent"],
    { stdio: "ignore" },
  );
  const pub = createPublicClient({ transport: http(rpc), pollingInterval: 50 });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await pub.getChainId()) === 8453) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const chain = { ...base, rpcUrls: { default: { http: [rpc] } } };
  const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const operator = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const seller = mnemonicToAccount(mnemonic, { addressIndex: 2 }).address;
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });

  // Install the mock's runtime code at the canonical USDC address (EIP-712 domain is rebuilt for the new address).
  const mock = artifact("E2E.sol", "MockUSDCWithVRS");
  const tmp = await pub.waitForTransactionReceipt({
    hash: await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode }),
  });
  const runtime = await pub.getCode({ address: tmp.contractAddress as Address });
  await pub.request({ method: "anvil_setCode" as never, params: [USDC, runtime] as never });

  const fac = artifact("KeyframeEscrowFactory.sol", "KeyframeEscrowFactory");
  const r = await pub.waitForTransactionReceipt({
    hash: await wallet.deployContract({ abi: fac.abi, bytecode: fac.bytecode, args: [USDC, seller] }),
  });
  const factory = getAddress(r.contractAddress as Address);
  return {
    rpc,
    pub,
    factory,
    seller,
    operatorKey: bytesToHex(operator.getHdKey().privateKey as Uint8Array),
    mnemonic,
    chain,
    async mint(to, amount) {
      await pub.waitForTransactionReceipt({
        hash: await wallet.writeContract({ address: USDC, abi: MINT_ABI, functionName: "mint", args: [to, amount] }),
      });
    },
    balance: (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
    stop: () => proc.kill(),
  };
}

// ---------------------------------------------------------------- API wired to the local chain

class MemoryRelayerStore implements RelayerStore {
  nonce: number | undefined;
  readonly txs = new Map<string, StoredTx>();
  async getNonce() {
    return this.nonce;
  }
  async putNonce(n: number) {
    this.nonce = n;
  }
  async putTx(h: Hex, t: StoredTx) {
    this.txs.set(h, t);
  }
  async getTx(h: Hex) {
    return this.txs.get(h);
  }
  async deleteTx(h: Hex) {
    this.txs.delete(h);
  }
}

/** A Harness whose chain reads and relayer are real (RelayerCore with an in-memory nonce/tx store). */
export async function chainHarness(c: LocalChain, usdc = 100_000_000n): Promise<{ h: Harness; buyer: LocalAccount }> {
  const buyer = privateKeyToAccount(generatePrivateKey());
  await c.mint(buyer.address, usdc);
  let h: Harness | null = null;
  const core = new RelayerCore({
    account: privateKeyToAccount(c.operatorKey),
    client: c.pub,
    factory: c.factory,
    chainId: 8453,
    store: new MemoryRelayerStore(),
    journal: (e) =>
      (h as Harness).repo.journalTx({
        hash: e.hash,
        kind: e.kind,
        ref: e.ref,
        nonce: e.nonce,
        status: e.status,
        error: e.error ?? null,
        created_at: e.at,
      }),
  });
  const relayer: RelayerClient = { send: (r) => core.send(r), receipt: (x, w) => core.receipt(x, w) };
  h = new Harness({
    buyer,
    relayerKey: c.operatorKey,
    chain: viemChainReader(c.rpc),
    relayer,
    env: { RPC_URL: c.rpc, FACTORY_ADDRESS: c.factory, SELLER_ADDRESS: c.seller },
  });
  return { h, buyer };
}
