import type { Hex } from "viem";

// Wire types between the API and the relayer Durable Object (structured-clone safe: no bigint in logs).

export type TxKind =
  | "fund"
  | "register"
  | "release"
  | "deliver"
  | "decide"
  | "cancel"
  | "refund"
  | "refund_expired"
  | "sweep";

/** Every relayed call targets FACTORY_ADDRESS; the relayer has no way to send anywhere else. */
export interface RelayRequest {
  kind: TxKind;
  /** Order id / terms hash, for the journal. */
  ref: string;
  data: Hex;
  /** How long to wait for the receipt before answering "pending" (0 = return right after broadcast). */
  waitMs: number;
}

export interface RelayLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

export type ReceiptResult =
  | { state: "confirmed"; hash: Hex; blockNumber: string; logs: RelayLog[] }
  | { state: "pending"; hash: Hex }
  | { state: "reverted"; hash: Hex; reason: string };

export type RelayResult =
  | ReceiptResult
  /** Simulation reverted: nothing was broadcast. `reason` is the decoded custom error when known. */
  | { state: "rejected"; reason: string }
  /** The relayer could not broadcast (no key/gas/RPC): nothing was sent, so a fallback rail is safe. */
  | { state: "unavailable"; reason: string };

export interface RelayerClient {
  send(req: RelayRequest): Promise<RelayResult>;
  receipt(hash: Hex, waitMs: number): Promise<ReceiptResult | { state: "unknown"; hash: Hex }>;
}
