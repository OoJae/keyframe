// Buyer-wallet inspection and payment-route choice (frozen-interfaces.md §9 KEYFRAME_PRIMARY_RAIL /
// KEYFRAME_7702_POLICY). x402 (EIP-3009) needs a plain ECDSA wallet; an EIP-7702-delegated wallet pays by a direct
// USDC.transfer to the same escrow when it has gas, else x402 relying on PayBox's auto-undelegate.

import { type Address, getAddress, type Hex } from "viem";
import { detect7702 } from "../protocol/index.js";
import { codeRead, ethRead, usdcRead } from "./chain.js";
import type { Config } from "./config.js";
import type { CrossRead, Read } from "./rpc.js";
import { eth, shortAddr, usdc } from "./text.js";

/** Enough Base ETH for one ERC-20 transfer with a wide margin (architecture: warn below 2e13 wei). */
export const MIN_GAS_WEI = 20_000_000_000_000n;

export type WalletKind = "plain" | "delegated" | "contract" | "unknown";
export type WalletView = {
  address: Address;
  kind: WalletKind;
  delegate: Address | null;
  usdc_atomic: string | null;
  eth_wei: string | null;
  shortfall_atomic: string | null;
  consistent: boolean;
};
export type RouteKind = "x402" | "direct" | "fund_first";
export type Route = { kind: RouteKind; reason: string; wallet: WalletView };

export const walletReads = (a: Address): Read<unknown>[] => [codeRead(a), ethRead(a), usdcRead(a)];

export function walletView(rpc: CrossRead, a: Address, amount: bigint): WalletView {
  const code = rpc.get(codeRead(a));
  const ethBal = rpc.get(ethRead(a));
  const usdcBal = rpc.get(usdcRead(a));
  let kind: WalletKind = "unknown";
  let delegate: Address | null = null;
  if (code.value !== undefined) {
    kind = detect7702(code.value as Hex);
    if (kind === "delegated") delegate = getAddress(`0x${(code.value as string).slice(8)}`);
  }
  const u = usdcBal.value;
  return {
    address: getAddress(a),
    kind,
    delegate,
    usdc_atomic: u === undefined ? null : u.toString(),
    eth_wei: ethBal.value === undefined ? null : ethBal.value.toString(),
    shortfall_atomic: u !== undefined && u < amount ? (amount - u).toString() : null,
    consistent: code.agree && ethBal.agree && usdcBal.agree,
  };
}

export function chooseRoute(cfg: Config, w: WalletView, amount: bigint): Route {
  const at = shortAddr(w.address);
  if (w.shortfall_atomic !== null) {
    return {
      kind: "fund_first",
      wallet: w,
      reason: `wallet ${at} has ${usdc(w.usdc_atomic ?? "0")} USDC on Base; this costs ${usdc(amount)}. Add at least ${usdc(w.shortfall_atomic)} USDC on Base first (core get_buy_link), or pick a cheaper format; or, if the user holds USDC on Solana, move it to this Base wallet with core request_swap, then quote again`,
    };
  }
  const ethWei = w.eth_wei === null ? null : BigInt(w.eth_wei);
  const hasGas = ethWei !== null && ethWei >= MIN_GAS_WEI;
  const gasNote = ethWei === null ? "" : ` (${eth(ethWei)} ETH for gas)`;
  const needGas = (why: string): Route => ({
    kind: "fund_first",
    wallet: w,
    reason: `${why}, which needs a little ETH on Base for gas; wallet ${at} has ${eth(ethWei ?? 0n)} ETH. Add about 0.0001 ETH on Base (core get_buy_link), then quote again`,
  });

  if (w.kind === "unknown") {
    return {
      kind: cfg.primaryRail,
      wallet: w,
      reason: `could not read wallet ${at} on Base; using the ${cfg.primaryRail === "x402" ? "default x402 route" : "direct route"}`,
    };
  }
  if (cfg.primaryRail === "direct") {
    return hasGas
      ? { kind: "direct", wallet: w, reason: `Keyframe currently takes direct USDC transfers${gasNote}` }
      : needGas("Keyframe currently takes direct USDC transfers");
  }
  if (w.kind === "contract") {
    return hasGas
      ? {
          kind: "direct",
          wallet: w,
          reason: `wallet ${at} is a smart contract, so it pays by direct USDC transfer${gasNote}`,
        }
      : needGas(`wallet ${at} is a smart contract and can only pay by direct transfer`);
  }
  if (w.kind === "delegated") {
    if (cfg.policy7702 === "direct-first" && hasGas) {
      return {
        kind: "direct",
        wallet: w,
        reason: `wallet ${at} is in smart-account mode (EIP-7702), which x402 can't pay from, so it pays by a direct USDC transfer to the same escrow${gasNote}`,
      };
    }
    return {
      kind: "x402",
      wallet: w,
      reason: `wallet ${at} is in smart-account mode (EIP-7702); PayBox may switch it back to a plain wallet (auto-undelegate) to sign the x402 payment. If that is refused, add a little Base ETH and use keyframe_commission_direct`,
    };
  }
  return { kind: "x402", wallet: w, reason: `wallet ${at} is a plain wallet: one approval, no gas` };
}
