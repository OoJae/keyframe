// Typed Base reads on top of rpc.ts: code, ETH/token balances, factory.order(termsHash) and receipts. The factory's
// storage view replaces event scans (the plugin never calls eth_getLogs).

import {
  type Address,
  concat,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Hex,
  isAddressEqual,
} from "viem";
import { erc20Abi, keyframeFactoryAbi, Status, USDC } from "../protocol/index.js";
import type { Read } from "./rpc.js";

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

function hexBytes(v: unknown): Hex {
  if (typeof v !== "string" || !HEX_BYTES.test(v)) throw new TypeError("not hex bytes");
  return v.toLowerCase() as Hex;
}

function quantity(v: unknown): bigint {
  if (typeof v !== "string" || !QUANTITY.test(v)) throw new TypeError("not a quantity");
  return BigInt(v);
}

const call = (to: Address, data: Hex) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

export const codeRead = (a: Address): Read<Hex> => ({
  key: `code:${a.toLowerCase()}`,
  req: { method: "eth_getCode", params: [a, "latest"] },
  decode: hexBytes,
});

export const ethRead = (a: Address): Read<bigint> => ({
  key: `eth:${a.toLowerCase()}`,
  req: { method: "eth_getBalance", params: [a, "latest"] },
  decode: quantity,
});

export const tokenRead = (token: Address, a: Address): Read<bigint> => ({
  key: `bal:${token.toLowerCase()}:${a.toLowerCase()}`,
  req: call(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [a] })),
  decode: (r) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: hexBytes(r) }),
});

export const usdcRead = (a: Address): Read<bigint> => tokenRead(USDC, a);

export type OrderView = {
  status: number;
  buyer: Address;
  deadline: bigint;
  reviewWindow: number;
  openedAt: bigint;
  deliveredAt: bigint;
  finalAt: bigint;
  accepted: boolean;
  key: Hex;
  manifestHash: Hex;
  toSeller: bigint;
  toBuyer: bigint;
};

export const orderRead = (factory: Address, termsHash: Hex): Read<OrderView> => ({
  key: `order:${factory.toLowerCase()}:${termsHash.toLowerCase()}`,
  req: call(factory, encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "order", args: [termsHash] })),
  decode: (r) => {
    const o = decodeFunctionResult({ abi: keyframeFactoryAbi, functionName: "order", data: hexBytes(r) });
    if (o.status > Status.Rejected) throw new RangeError("unknown status");
    return { ...o, key: o.key.toLowerCase() as Hex, manifestHash: o.manifestHash.toLowerCase() as Hex };
  },
});

export type ReceiptLog = { address: Address; topics: Hex[]; data: Hex };
export type Receipt = { status: "success" | "reverted"; to: Address | null; logs: ReceiptLog[] };

export const receiptRead = (txHash: Hex): Read<Receipt | null> => ({
  key: `receipt:${txHash.toLowerCase()}`,
  req: { method: "eth_getTransactionReceipt", params: [txHash] },
  decode: (r) => {
    if (r === null) return null;
    if (typeof r !== "object") throw new TypeError("bad receipt");
    const x = r as { status?: unknown; to?: unknown; logs?: unknown };
    if (!Array.isArray(x.logs) || x.logs.length > 2_000) throw new TypeError("bad logs");
    return {
      status: quantity(x.status) === 1n ? "success" : "reverted",
      to: typeof x.to === "string" ? getAddress(x.to) : null,
      logs: x.logs.map((l: { address?: unknown; topics?: unknown; data?: unknown }) => ({
        address: getAddress(String(l.address)),
        topics: Array.isArray(l.topics) ? l.topics.map(hexBytes) : [],
        data: hexBytes(l.data),
      })),
    };
  },
});

/** Sum of USDC Transfer(from -> to) amounts in a receipt. */
export function usdcTransferred(receipt: Receipt, from: Address, to: Address): bigint {
  let total = 0n;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, USDC)) continue;
    try {
      const ev = decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (isAddressEqual(ev.args.from, from) && isAddressEqual(ev.args.to, to)) total += ev.args.value;
    } catch {
      // not a Transfer log
    }
  }
  return total;
}

const CLONE_RUNTIME_PREFIX = "0x363d3d373d3d3d363d73";
const CLONE_RUNTIME_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3";

/** Deployed runtime of an OZ v5 EIP-1167 clone of `impl`. */
export const cloneRuntime = (impl: Address): Hex =>
  concat([CLONE_RUNTIME_PREFIX, impl, CLONE_RUNTIME_SUFFIX]).toLowerCase() as Hex;

export type EscrowCode = "none" | "eip1167" | "other";

export function classifyEscrowCode(code: Hex, vaultImpl: Address): EscrowCode {
  if (code === "0x") return "none";
  return code.toLowerCase() === cloneRuntime(vaultImpl) ? "eip1167" : "other";
}

export const STATUS_NAMES = ["None", "Open", "Delivered", "Released", "Refunded", "Cancelled", "Rejected"] as const;
export type StatusName = (typeof STATUS_NAMES)[number];
export const statusName = (s: number): StatusName => STATUS_NAMES[s] ?? "None";
