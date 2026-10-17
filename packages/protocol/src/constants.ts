import type { Address, Hex } from "viem";

/** Base mainnet (frozen-interfaces.md, header). */
export const CHAIN_ID = 8453;
export const CAIP2 = "eip155:8453";

/** Base USDC (FiatTokenV2_2), EIP-55 checksummed. */
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const satisfies Address;
export const USDC_DECIMALS = 6;
/** USDC's own EIP-712 domain, advertised in x402 `extra` (EIP-3009 signing). */
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";

/** Factory caps (atomic USDC): 0.10 .. 50.00. */
export const MIN_AMOUNT = 100_000n;
export const MAX_AMOUNT = 50_000_000n;

export const EIP712_NAME = "Keyframe Escrow";
export const EIP712_VERSION = "1";

/** EIP-712 `Terms(...)` (§1). Member order is part of the type hash. */
export const TERMS_TYPES = {
  Terms: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "operator", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "dueAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "reviewWindow", type: "uint32" },
    { name: "slaFloorBps", type: "uint16" },
    { name: "killFeeBps", type: "uint16" },
    { name: "keyHash", type: "bytes32" },
    { name: "specHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** EIP-712 `Decision(bytes32 termsHash,bool accept,uint256 deadline)` (§1, Studio review). */
export const DECISION_TYPES = {
  Decision: [
    { name: "termsHash", type: "bytes32" },
    { name: "accept", type: "bool" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Canonical EIP-1167 init code = CLONE_PREFIX ‖ impl ‖ CLONE_SUFFIX (OpenZeppelin v5 `Clones`, §2). */
export const CLONE_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" as const satisfies Hex;
export const CLONE_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3" as const satisfies Hex;

/** KFC1 plaintext chunk size; each full ciphertext chunk is this + 16-byte GCM tag = 1 MiB (§5). */
export const KFC1_CHUNK_PLAINTEXT = 1_048_560;
export const KFC1_TAG_BYTES = 16;
export const KFC1_CHUNK_CIPHERTEXT = KFC1_CHUNK_PLAINTEXT + KFC1_TAG_BYTES;

/** Mirror of the Solidity `enum Status` (§3). Plain object, not a TS enum, so it survives type stripping. */
export const Status = {
  None: 0,
  Open: 1,
  Delivered: 2,
  Released: 3,
  Refunded: 4,
  Cancelled: 5,
  Rejected: 6,
} as const;
export type Status = (typeof Status)[keyof typeof Status];
