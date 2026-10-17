import { erc20Abi, keyframeFactoryAbi, Status } from "@keyframe/protocol";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { type Address, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import {
  DEFAULT_LOGS_BUDGET_MS,
  DEFAULT_LOGS_MAX_RANGE,
  estimateBlockAt,
  FALLBACK_CHUNK_BLOCKS,
  LogsRangeError,
  scanLogs,
} from "./logs.js";

// Read-only chain access (any RPC). Writes go exclusively through the relayer Durable Object. eth_getLogs goes
// through scanLogs (src/logs.ts): LOGS_RPC_URL in wide windows, RPC_URL in 10-block chunks as the fallback.

export interface OrderView {
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
}

export interface TokenTransfer {
  from: Address;
  value: bigint;
  tx: Hex;
}

/** Factory events whose transaction fills an order's *_tx field when someone else moved the order. */
export type OrderEvent = "Opened" | "Released" | "Refunded" | "Cancelled" | "Decided" | "Delivered";

/**
 * How far back a log lookup reads. With `sinceS` (unix seconds at or before the earliest log wanted: a quote's
 * created_at, an order's openedAt/finalAt) the scan starts at the block estimated for that time (2 s Base blocks,
 * 30 blocks of margin); without it, a fixed default lookback.
 */
export interface LogQuery {
  sinceS?: number;
  /** "Now" on the clock `sinceS` was read from: the API clock for DB times. Omitted: the latest block's timestamp. */
  nowS?: number;
  /** Absolute Date.now() deadline for the whole scan (default: 10 s from the call). */
  deadlineMs?: number;
}

/** Default lookbacks when no time is known (blocks). */
export const TRANSFERS_LOOKBACK_BLOCKS = 2_000;
export const EVENT_LOOKBACK_BLOCKS = 9_000;
/** Widest scan (≈ 11 h of Base). transfersTo refuses a wider one; event lookups read its first part only. */
export const MAX_SCAN_BLOCKS = 20_000;

export interface ChainReaderOptions {
  /** RPC used only for eth_getLogs (null or omitted: RPC_URL serves logs too). */
  logsRpcUrl?: string | null;
  /** Blocks per eth_getLogs request on the logs RPC (default 2000). */
  logsMaxRange?: number;
}

export interface ChainReader {
  orderOf(factory: Address, termsHash: Hex): Promise<OrderView>;
  balanceOf(token: Address, account: Address): Promise<bigint>;
  refundableCount(factory: Address, maxScan: number): Promise<bigint>;
  /** eth_call of refundExpired(maxScan) from `from`: how many entries a real call would refund now. */
  simulateRefundExpired(factory: Address, maxScan: number, from: Address): Promise<bigint>;
  /** EIP-3009 authorizationState(authorizer, nonce) on the token: true once the authorization was used. */
  authorizationState(token: Address, authorizer: Address, nonce: Hex): Promise<boolean>;
  /** Every token Transfer log into `to` since `q` (all of them, or a LogsRangeError: never a partial list). */
  transfersTo(token: Address, to: Address, q?: LogQuery): Promise<TokenTransfer[]>;
  /** Hash of the first tx that emitted `event(termsHash)` since `q`, if any. */
  eventTx(factory: Address, event: OrderEvent, termsHash: Hex, q?: LogQuery): Promise<Hex | null>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** ERC-1271 / ERC-6492-aware checks for contract wallets (EOAs are verified offline first). */
  verifyTypedData(args: Parameters<PublicClient["verifyTypedData"]>[0]): Promise<boolean>;
  verifyMessage(args: { address: Address; message: string; signature: Hex }): Promise<boolean>;
  getCode(address: Address): Promise<Hex | undefined>;
  /** Hash of the tx that emitted Opened(termsHash) since `q`, if any. */
  openedTx(factory: Address, termsHash: Hex, q?: LogQuery): Promise<Hex | null>;
  /** Read-only signer for the local x402 exact verifier (simulation via eth_call). */
  x402Signer(addresses: readonly Address[]): FacilitatorEvmSigner;
}

export const isTerminal = (s: number): boolean =>
  s === Status.Released || s === Status.Refunded || s === Status.Cancelled || s === Status.Rejected;

const readOnly = (what: string) => (): never => {
  throw new Error(`read-only signer: ${what} is not available (settlement goes through the relayer)`);
};

export function viemChainReader(rpcUrl: string, opts: ChainReaderOptions = {}): ChainReader {
  const client = createPublicClient({
    chain: base,
    // No JSON-RPC batching: viem keeps one batch scheduler per URL for the whole isolate, so a batch would carry
    // calls from concurrent requests on one request's fetch. workerd cancels a request whose only pending work
    // belongs to another request ("code had hung"), which turned the loser of two concurrent payments for one
    // quote into a 500 instead of a 409 (e2e fork run, docs/evidence/INTEGRATION.md).
    transport: http(rpcUrl, { timeout: 4_000, retryCount: 1, batch: false }),
  });
  // eth_getLogs only; never batched either (same reason).
  const logsClient =
    opts.logsRpcUrl && opts.logsRpcUrl !== rpcUrl
      ? createPublicClient({
          chain: base,
          transport: http(opts.logsRpcUrl, { timeout: 5_000, retryCount: 1, batch: false }),
        })
      : null;
  const maxRange = opts.logsMaxRange ?? DEFAULT_LOGS_MAX_RANGE;

  /** [from, latest] for `q`; `latest` is read from RPC_URL (uncached: a deposit may be in the newest block). */
  async function rangeOf(q: LogQuery | undefined, lookback: number): Promise<{ from: bigint; latest: bigint }> {
    if (q?.sinceS !== undefined && q.sinceS > 0) {
      if (q.nowS !== undefined) {
        const latest = await client.getBlockNumber({ cacheTime: 0 });
        return { from: estimateBlockAt(latest, q.nowS, q.sinceS), latest };
      }
      const head = await client.getBlock({ blockTag: "latest" });
      return { from: estimateBlockAt(head.number, Number(head.timestamp), q.sinceS), latest: head.number };
    }
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    return { from: latest > BigInt(lookback) ? latest - BigInt(lookback) : 0n, latest };
  }

  /** The one eth_getLogs path: logs RPC in wide windows, RPC_URL for the head and as the chunked fallback. */
  function scan<T>(
    from: bigint,
    to: bigint,
    fetch: (c: typeof client, fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    q: LogQuery | undefined,
    first: boolean,
  ): Promise<T[]> {
    return scanLogs(
      from,
      to,
      (a, b) => fetch(logsClient ?? client, a, b),
      (a, b) => fetch(client, a, b),
      {
        maxRange,
        deadlineMs: q?.deadlineMs ?? Date.now() + DEFAULT_LOGS_BUDGET_MS,
        first,
        headBlocks: logsClient ? FALLBACK_CHUNK_BLOCKS : 0,
      },
    );
  }

  async function eventTx(factory: Address, event: OrderEvent, termsHash: Hex, q?: LogQuery): Promise<Hex | null> {
    const { from, latest } = await rangeOf(q, EVENT_LOOKBACK_BLOCKS);
    // The event is at (or just after) the estimated block: the oldest-first scan stops at the first hit.
    const to = latest - from + 1n > BigInt(MAX_SCAN_BLOCKS) ? from + BigInt(MAX_SCAN_BLOCKS) - 1n : latest;
    const logs = await scan(
      from,
      to,
      (c, fromBlock, toBlock) =>
        c.getContractEvents({
          address: factory,
          abi: keyframeFactoryAbi,
          eventName: event,
          args: { termsHash } as never,
          fromBlock,
          toBlock,
        }),
      q,
      true,
    );
    return (logs[0]?.transactionHash as Hex | undefined) ?? null;
  }

  return {
    async orderOf(factory, termsHash) {
      const v = await client.readContract({
        address: factory,
        abi: keyframeFactoryAbi,
        functionName: "order",
        args: [termsHash],
      });
      return v as unknown as OrderView;
    },
    balanceOf: (token, account) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    refundableCount: (factory, maxScan) =>
      client.readContract({
        address: factory,
        abi: keyframeFactoryAbi,
        functionName: "refundableCount",
        args: [BigInt(maxScan)],
      }),
    async simulateRefundExpired(factory, maxScan, from) {
      const { result } = await client.simulateContract({
        address: factory,
        abi: keyframeFactoryAbi,
        functionName: "refundExpired",
        args: [BigInt(maxScan)],
        account: from,
      });
      return result as bigint;
    },
    authorizationState: (token, authorizer, nonce) =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "authorizationState",
        args: [authorizer, nonce],
      }),
    async transfersTo(token, to, q) {
      const { from, latest } = await rangeOf(q, TRANSFERS_LOOKBACK_BLOCKS);
      if (latest - from + 1n > BigInt(MAX_SCAN_BLOCKS)) {
        throw new LogsRangeError(`Transfer scan of ${latest - from + 1n} blocks exceeds ${MAX_SCAN_BLOCKS}`);
      }
      const logs = await scan(
        from,
        latest,
        (c, fromBlock, toBlock) =>
          c.getContractEvents({
            address: token,
            abi: erc20Abi,
            eventName: "Transfer",
            args: { to },
            fromBlock,
            toBlock,
          }),
        q,
        false,
      );
      return logs.map((l) => ({
        from: (l.args as { from: Address }).from,
        value: (l.args as { value: bigint }).value,
        tx: l.transactionHash as Hex,
      }));
    },
    eventTx,
    async blockTimestamp(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
    verifyTypedData: (args) => client.verifyTypedData(args),
    verifyMessage: (args) => client.verifyMessage(args),
    getCode: (address) => client.getCode({ address }),
    openedTx: (factory, termsHash, q) => eventTx(factory, "Opened", termsHash, q),
    x402Signer: (addresses) => ({
      getAddresses: () => addresses,
      readContract: (args) => client.readContract(args as Parameters<typeof client.readContract>[0]),
      verifyTypedData: (args) => client.verifyTypedData(args as Parameters<typeof client.verifyTypedData>[0]),
      getCode: (args) => client.getCode(args),
      waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      writeContract: readOnly("writeContract"),
      sendTransaction: readOnly("sendTransaction"),
    }),
  };
}
