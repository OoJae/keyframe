import { erc20Abi, keyframeFactoryAbi, Status } from "@keyframe/protocol";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { type Address, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { base } from "viem/chains";

// Read-only chain access (any RPC). Writes go exclusively through the relayer Durable Object.

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

export interface ChainReader {
  orderOf(factory: Address, termsHash: Hex): Promise<OrderView>;
  balanceOf(token: Address, account: Address): Promise<bigint>;
  refundableCount(factory: Address, maxScan: number): Promise<bigint>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** ERC-1271 / ERC-6492-aware checks for contract wallets (EOAs are verified offline first). */
  verifyTypedData(args: Parameters<PublicClient["verifyTypedData"]>[0]): Promise<boolean>;
  verifyMessage(args: { address: Address; message: string; signature: Hex }): Promise<boolean>;
  getCode(address: Address): Promise<Hex | undefined>;
  /** Hash of the tx that emitted Opened(termsHash) within the last `lookbackBlocks`, if any. */
  openedTx(factory: Address, termsHash: Hex, lookbackBlocks?: number): Promise<Hex | null>;
  /** Read-only signer for the local x402 exact verifier (simulation via eth_call). */
  x402Signer(addresses: readonly Address[]): FacilitatorEvmSigner;
}

export const isTerminal = (s: number): boolean =>
  s === Status.Released || s === Status.Refunded || s === Status.Cancelled || s === Status.Rejected;

const readOnly = (what: string) => (): never => {
  throw new Error(`read-only signer: ${what} is not available (settlement goes through the relayer)`);
};

export function viemChainReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({
    chain: base,
    // No JSON-RPC batching: viem keeps one batch scheduler per URL for the whole isolate, so a batch would carry
    // calls from concurrent requests on one request's fetch. workerd cancels a request whose only pending work
    // belongs to another request ("code had hung"), which turned the loser of two concurrent payments for one
    // quote into a 500 instead of a 409 (e2e fork run, docs/evidence/INTEGRATION.md).
    transport: http(rpcUrl, { timeout: 4_000, retryCount: 1, batch: false }),
  });
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
    async blockTimestamp(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
    verifyTypedData: (args) => client.verifyTypedData(args),
    verifyMessage: (args) => client.verifyMessage(args),
    getCode: (address) => client.getCode({ address }),
    async openedTx(factory, termsHash, lookbackBlocks = 9_000) {
      const latest = await client.getBlockNumber();
      const logs = await client.getContractEvents({
        address: factory,
        abi: keyframeFactoryAbi,
        eventName: "Opened",
        args: { termsHash },
        fromBlock: latest > BigInt(lookbackBlocks) ? latest - BigInt(lookbackBlocks) : 0n,
        toBlock: latest,
      });
      return logs[0]?.transactionHash ?? null;
    },
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
