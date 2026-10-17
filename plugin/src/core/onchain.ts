// One cross-checked Base snapshot of an escrow: factory.order(termsHash), the escrow's USDC balance and code.

import type { Address, Hex } from "viem";
import {
  classifyEscrowCode,
  codeRead,
  type EscrowCode,
  type OrderView,
  orderRead,
  statusName,
  usdcRead,
} from "./chain.js";
import type { FactoryEntry } from "./config.js";
import type { Budget } from "./net.js";
import { type CrossRead, crossRead, type Read } from "./rpc.js";

export type OnchainView = {
  factory: Address;
  terms_hash: Hex;
  escrow: Address;
  status: ReturnType<typeof statusName> | null;
  escrow_code: EscrowCode | null;
  escrow_balance_atomic: string | null;
  deadline: number | null;
  delivered_at: number | null;
  final_at: number | null;
  key_published: boolean;
  to_seller_atomic: string | null;
  to_buyer_atomic: string | null;
  rpcs_answered: number;
  rpcs_configured: number;
  consistent: boolean;
};

export type Snapshot = {
  view: OnchainView;
  order: OrderView | undefined;
  balance: bigint | undefined;
  code: EscrowCode | undefined;
  /** Number of RPCs whose order() answer was decodable. */
  orderSeen: number;
  rpc: CrossRead;
};

const ZERO32 = `0x${"0".repeat(64)}`;

export async function snapshot(
  rpcUrls: readonly string[],
  budget: Budget,
  factory: FactoryEntry,
  termsHash: Hex,
  escrow: Address,
  extra: Read<unknown>[] = [],
): Promise<Snapshot> {
  const oRead = orderRead(factory.address, termsHash);
  const bRead = usdcRead(escrow);
  const cRead = codeRead(escrow);
  const rpc = await crossRead(rpcUrls, [oRead, bRead, cRead, ...extra], budget);
  const o = rpc.get(oRead);
  const b = rpc.get(bRead);
  const c = rpc.get(cRead);
  const extraAgree = extra.every((r) => rpc.get(r).agree);
  const order = o.value;
  const code = c.value === undefined ? undefined : classifyEscrowCode(c.value, factory.vaultImpl);
  const n = (x: bigint | undefined) => (x === undefined || x === 0n ? null : Number(x));
  return {
    order,
    balance: b.value,
    code,
    orderSeen: o.seen,
    rpc,
    view: {
      factory: factory.address,
      terms_hash: termsHash,
      escrow,
      status: order ? statusName(order.status) : null,
      escrow_code: code ?? null,
      escrow_balance_atomic: b.value === undefined ? null : b.value.toString(),
      deadline: order && order.status !== 0 ? Number(order.deadline) : null,
      delivered_at: n(order?.deliveredAt),
      final_at: n(order?.finalAt),
      key_published: order !== undefined && order.key !== ZERO32,
      to_seller_atomic: order && order.status >= 3 ? order.toSeller.toString() : null,
      to_buyer_atomic: order && order.status >= 3 ? order.toBuyer.toString() : null,
      rpcs_answered: rpc.responded,
      rpcs_configured: rpc.configured,
      consistent: o.agree && b.agree && c.agree && extraAgree,
    },
  };
}

/**
 * L4: at least two Base RPCs answered every read the decision depends on (the order record, the escrow balance and
 * any extra read) and they all agree. One RPC alone, or a disagreement, never decides a proposal.
 */
export function crossChecked(s: Snapshot, extra: Read<unknown>[] = []): boolean {
  const reads = [orderRead(s.view.factory, s.view.terms_hash), usdcRead(s.view.escrow), ...extra];
  return reads.every((r) => {
    const v = s.rpc.get(r);
    return v.seen >= 2 && v.agree;
  });
}
