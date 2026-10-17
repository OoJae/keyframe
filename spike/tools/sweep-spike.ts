// sweep-spike: recover USDC parked at spike payees (HD indexes of SPIKE_MNEMONIC) back to a destination, gaslessly
// for the payee, using Base USDC's EIP-3009 transferWithAuthorization.
//
//   Dry run (default): derive the payee addresses, read code + USDC balance, print the plan. Nothing is signed.
//   --sign:            also sign one authorization per funded payee and print it for manual relay (cast send ...).
//   --submit:          sign and relay each authorization from RELAYER_PRIVATE_KEY (pays the gas), wait for receipts.
//
// Secrets come only from the environment and are never printed: SPIKE_MNEMONIC (required), RELAYER_PRIVATE_KEY (--submit).
//
//   SPIKE_MNEMONIC="$(...)" pnpm -C spike/tools sweep --indexes 0,1,2 --to 0xYourWalletA
//   SPIKE_MNEMONIC=... RELAYER_PRIVATE_KEY=... pnpm -C spike/tools sweep --indexes 0-3 --to 0x... --submit

import { parseArgs } from "node:util";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  type Hex,
  http,
  isAddress,
  parseAbi,
  parseSignature,
  toHex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function die(message: string): never {
  process.stderr.write(`sweep-spike: ${message}\n`);
  process.exit(1);
}

function parseIndexes(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b < a || b - a > 999) die(`bad range ${part}`);
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(part)) out.add(Number(part));
    else die(`bad index ${part}`);
  }
  if (out.size === 0) die("no indexes given");
  for (const i of out) if (i >= 0x80000000) die(`index ${i} out of range`);
  return [...out].sort((a, b) => a - b);
}

/** Same normalisation as the spike server (src/hd.ts), so both derive identical addresses. */
function normalizeMnemonic(raw: string): string {
  const m = raw.normalize("NFKD").trim().split(/\s+/).join(" ");
  if (![12, 15, 18, 21, 24].includes(m.split(" ").length)) die("SPIKE_MNEMONIC must have 12/15/18/21/24 words");
  return m;
}

const { values } = parseArgs({
  options: {
    indexes: { type: "string" },
    to: { type: "string" },
    rpc: { type: "string" },
    sign: { type: "boolean", default: false },
    submit: { type: "boolean", default: false },
    "valid-seconds": { type: "string", default: "3600" },
    "min-atomic": { type: "string", default: "1" },
  },
  strict: true,
});

if (!values.indexes) die("--indexes is required (e.g. 0,1,2 or 0-5)");
if (!values.to || !isAddress(values.to, { strict: false })) die("--to must be a 0x address (the destination wallet)");
const destination = getAddress(values.to);
const indexes = parseIndexes(values.indexes);
const validSeconds = Number(values["valid-seconds"]);
if (!Number.isInteger(validSeconds) || validSeconds < 60 || validSeconds > 86_400) die("--valid-seconds must be 60..86400");
if (!/^\d+$/.test(values["min-atomic"] ?? "")) die("--min-atomic must be an integer");
const minAtomic = BigInt(values["min-atomic"] ?? "1");
const mode = values.submit ? "submit" : values.sign ? "sign" : "dry-run";

const rawMnemonic = process.env.SPIKE_MNEMONIC;
if (!rawMnemonic) die("set SPIKE_MNEMONIC in the environment (never pass it as an argument)");
const mnemonic = normalizeMnemonic(rawMnemonic);
const rpcUrl = values.rpc ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 15_000 }) });

const relayer = mode === "submit"
  ? (() => {
      const key = process.env.RELAYER_PRIVATE_KEY?.trim();
      if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) die("--submit needs RELAYER_PRIVATE_KEY (0x + 64 hex) in the environment");
      return privateKeyToAccount(key as Hex);
    })()
  : null;

async function main() {
  console.log(`mode: ${mode}   destination: ${destination}   rpc host: ${new URL(rpcUrl).hostname}`);
  const chainId = await publicClient.getChainId();
  if (chainId !== 8453) die(`RPC is on chain ${chainId}, expected Base (8453)`);
  const [name, version] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: "name" }),
    publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: "version" }),
  ]);
  const domain = { name, version, chainId: 8453, verifyingContract: USDC } as const;
  console.log(`USDC EIP-712 domain: name="${name}" version="${version}" chainId=8453`);

  if (relayer) {
    const eth = await publicClient.getBalance({ address: relayer.address });
    console.log(`relayer: ${relayer.address}  ETH ${formatEther(eth)}`);
    if (eth === 0n) die("relayer has no ETH for gas");
  }
  const wallet = relayer ? createWalletClient({ account: relayer, chain: base, transport: http(rpcUrl, { timeout: 30_000 }) }) : null;

  let total = 0n;
  for (const index of indexes) {
    const account = mnemonicToAccount(mnemonic, { addressIndex: index });
    const [code, balance] = await Promise.all([
      publicClient.getCode({ address: account.address }),
      publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] }),
    ]);
    const codeState = !code || code === "0x" ? "codeless" : code.startsWith("0xef0100") ? "7702-delegated" : "HAS CODE";
    const line = `index ${index}  ${account.address}  ${codeState}  USDC ${balance} atomic`;
    if (balance < minAtomic) {
      console.log(`${line}  -> skip (below --min-atomic)`);
      continue;
    }
    total += balance;
    if (mode === "dry-run") {
      console.log(`${line}  -> would sweep ${balance} to ${destination}`);
      continue;
    }
    const now = Math.floor(Date.now() / 1000);
    const message = {
      from: account.address,
      to: destination,
      value: balance,
      validAfter: 0n,
      validBefore: BigInt(now + validSeconds),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const used = await publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: "authorizationState", args: [account.address, message.nonce] });
    if (used) die("random nonce already used (should never happen)");
    const signature = await account.signTypedData({ domain, types: TYPES, primaryType: "TransferWithAuthorization", message });
    const { r, s, v, yParity } = parseSignature(signature);
    const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);
    const args = [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, vNum, r, s] as const;

    if (mode === "sign") {
      // eth_call through the real USDC contract (caller = destination): proves the EIP-712 signature is accepted.
      const sim = await publicClient
        .simulateContract({ account: destination, address: USDC, abi: USDC_ABI, functionName: "transferWithAuthorization", args })
        .then(() => "accepted by USDC (eth_call)")
        .catch((e: unknown) => `REJECTED: ${e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message.split("\n")[0] : "error"}`);
      console.log(`${line}  -> simulation: ${sim}`);
      console.log(`${line}  -> signed authorization (relay with any funded key before ${new Date(Number(message.validBefore) * 1000).toISOString()}):`);
      console.log(JSON.stringify({ ...message, value: message.value.toString(), validAfter: "0", validBefore: message.validBefore.toString(), v: vNum, r, s }, null, 2));
      console.log(
        `cast send ${USDC} "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" ` +
          `${args.map((a) => a.toString()).join(" ")} --rpc-url ${rpcUrl} --account <relayer-keystore>`,
      );
      continue;
    }

    const { request } = await publicClient.simulateContract({ account: relayer!, address: USDC, abi: USDC_ABI, functionName: "transferWithAuthorization", args });
    const hash = await wallet!.writeContract(request);
    console.log(`${line}  -> relayed ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`   status ${receipt.status} in block ${receipt.blockNumber}; https://basescan.org/tx/${hash}`);
  }
  console.log(`total ${mode === "dry-run" ? "sweepable" : "swept/signed"}: ${total} atomic USDC (${Number(total) / 1e6} USDC)`);
}

main().catch((error: unknown) => {
  // Error messages from viem never contain the mnemonic or relayer key (they are not part of any request).
  die(error instanceof Error ? error.message.split("\n")[0] ?? "failed" : "failed");
});
