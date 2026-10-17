import { getAddress, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import {
  CAIP2,
  CHAIN_ID,
  CLONE_PREFIX,
  CLONE_SUFFIX,
  DECISION_TYPES,
  KFC1_CHUNK_PLAINTEXT,
  MAX_AMOUNT,
  MIN_AMOUNT,
  Status,
  TERMS_TYPES,
  USDC,
  USDC_DECIMALS,
} from "../src/index.js";

const typeString = (name: string, fields: readonly { name: string; type: string }[]) =>
  `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;

describe("constants (frozen-interfaces §1-§5)", () => {
  it("chain, token and caps", () => {
    expect(CHAIN_ID).toBe(8453);
    expect(CAIP2).toBe("eip155:8453");
    expect(USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(getAddress(USDC)).toBe(USDC);
    expect(USDC_DECIMALS).toBe(6);
    expect(MIN_AMOUNT).toBe(100_000n);
    expect(MAX_AMOUNT).toBe(50_000_000n);
    expect(KFC1_CHUNK_PLAINTEXT + 16).toBe(1 << 20);
  });

  it("EIP-712 type strings are exactly the frozen ones", () => {
    expect(typeString("Terms", TERMS_TYPES.Terms)).toBe(
      "Terms(address buyer,address seller,address operator,address token,uint256 amount,uint64 dueAt,uint64 deadline,uint32 reviewWindow,uint16 slaFloorBps,uint16 killFeeBps,bytes32 keyHash,bytes32 specHash,bytes32 contentHash,bytes32 salt)",
    );
    expect(typeString("Decision", DECISION_TYPES.Decision)).toBe(
      "Decision(bytes32 termsHash,bool accept,uint256 deadline)",
    );
  });

  it("clone init code is canonical EIP-1167 (55 bytes with impl)", () => {
    expect(CLONE_PREFIX).toBe("0x3d602d80600a3d3981f3363d3d373d3d3d363d73");
    expect(CLONE_SUFFIX).toBe("0x5af43d82803e903d91602b57fd5bf3");
    expect(toBytes(CLONE_PREFIX).length + 20 + toBytes(CLONE_SUFFIX).length).toBe(55);
  });

  it("Status mirrors the Solidity enum order", () => {
    expect(Object.entries(Status)).toEqual([
      ["None", 0],
      ["Open", 1],
      ["Delivered", 2],
      ["Released", 3],
      ["Refunded", 4],
      ["Cancelled", 5],
      ["Rejected", 6],
    ]);
  });
});

describe("public API surface", () => {
  it("exports exactly the frozen runtime names", () => {
    expect(Object.keys(protocol).sort()).toEqual(
      [
        "CAIP2",
        "CHAIN_ID",
        "CLONE_PREFIX",
        "CLONE_SUFFIX",
        "DECISION_TYPES",
        "EIP712_NAME",
        "EIP712_VERSION",
        "KFC1_CHUNK_PLAINTEXT",
        "MAX_AMOUNT",
        "MIN_AMOUNT",
        "ManifestSchema",
        "PaidResponseSchema",
        "QuoteSchema",
        "SpecSchema",
        "Status",
        "TERMS_TYPES",
        "TermsJsonSchema",
        "USDC",
        "USDC_DECIMALS",
        "buildPaymentRequiredV1",
        "buildPaymentRequiredV2",
        "decisionTypedData",
        "decryptKfc1Chunk",
        "deriveFileKey",
        "deriveKBuyer",
        "deriveKChain",
        "detect7702",
        "domainOf",
        "encryptKfc1",
        "erc20Abi",
        "escrowOf",
        "hashTerms",
        "jcs",
        "keyHashOf",
        "keyframeFactoryAbi",
        "keyframeVaultAbi",
        "newOrderId",
        "newQuoteId",
        "normalizeAccept",
        "parseMp4Header",
        "parsePaymentRequired",
        "payoutAt",
        "saltOf",
        "sha256Hex",
        "specHash",
        "termsFromJson",
        "termsToJson",
        "vaultImplOf",
        "verifyManifest",
      ].sort(),
    );
  });
});
