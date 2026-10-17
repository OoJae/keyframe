import fc from "fast-check";
import {
  type Address,
  concat,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  slice,
  toBytes,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  decisionTypedData,
  domainOf,
  escrowOf,
  hashTerms,
  payoutAt,
  type Terms,
  termsFromJson,
  termsToJson,
  USDC,
  vaultImplOf,
} from "../src/index.js";

const FACTORY: Address = "0x00000000000000000000000000000000000f4c70";

const T: Terms = {
  buyer: "0x1111111111111111111111111111111111111111",
  seller: "0x2222222222222222222222222222222222222222",
  operator: "0x3333333333333333333333333333333333333333",
  token: USDC,
  amount: 4_000_000n,
  dueAt: 1_798_760_000,
  deadline: 1_798_761_600,
  reviewWindow: 0,
  slaFloorBps: 2500,
  killFeeBps: 0,
  keyHash: `0x${"11".repeat(32)}`,
  specHash: `0x${"22".repeat(32)}`,
  contentHash: `0x${"33".repeat(32)}`,
  salt: `0x${"44".repeat(32)}`,
};

// Independent EIP-712 encoding (abi.encode of static members), not via viem's typed-data code path.
const TERMS_TYPE =
  "Terms(address buyer,address seller,address operator,address token,uint256 amount,uint64 dueAt,uint64 deadline,uint32 reviewWindow,uint16 slaFloorBps,uint16 killFeeBps,bytes32 keyHash,bytes32 specHash,bytes32 contentHash,bytes32 salt)";
function manualDomainSeparator(factory: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toBytes("Keyframe Escrow")),
        keccak256(toBytes("1")),
        8453n,
        factory,
      ],
    ),
  );
}
function manualTermsHash(t: Terms, factory: Address): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        ...(
          [
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint64",
            "uint64",
            "uint32",
            "uint16",
            "uint16",
          ] as const
        ).map((type) => ({ type })),
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        keccak256(toBytes(TERMS_TYPE)),
        t.buyer,
        t.seller,
        t.operator,
        t.token,
        t.amount,
        BigInt(t.dueAt),
        BigInt(t.deadline),
        t.reviewWindow,
        t.slaFloorBps,
        t.killFeeBps,
        t.keyHash,
        t.specHash,
        t.contentHash,
        t.salt,
      ] as never,
    ),
  );
  return keccak256(concat(["0x1901", manualDomainSeparator(factory), structHash]));
}

// Reference payout formula, written exactly as frozen-interfaces §3.
function refPayout(t: Terms, ts: bigint): bigint {
  const dueAt = BigInt(t.dueAt);
  const deadline = BigInt(t.deadline);
  if (dueAt === 0n || ts <= dueAt) return t.amount;
  const floor = (t.amount * BigInt(t.slaFloorBps)) / 10000n;
  if (ts >= deadline) return floor;
  return t.amount - ((t.amount - floor) * (ts - dueAt)) / (deadline - dueAt);
}

describe("hashTerms / domainOf", () => {
  it("equals an independent EIP-712 encoding", () => {
    expect(hashTerms(T, FACTORY)).toBe(manualTermsHash(T, FACTORY));
  });

  it("domain is {Keyframe Escrow, 1, 8453, factory}", () => {
    expect(domainOf(FACTORY)).toEqual({
      name: "Keyframe Escrow",
      version: "1",
      chainId: 8453,
      verifyingContract: getAddress(FACTORY),
    });
  });

  it("every field and the factory change the hash", () => {
    const base = hashTerms(T, FACTORY);
    const variants: Terms[] = [
      { ...T, buyer: "0x1111111111111111111111111111111111111112" },
      { ...T, amount: T.amount + 1n },
      { ...T, dueAt: T.dueAt + 1 },
      { ...T, deadline: T.deadline + 1 },
      { ...T, reviewWindow: 1 },
      { ...T, slaFloorBps: 2501 },
      { ...T, killFeeBps: 1 },
      { ...T, contentHash: `0x${"00".repeat(32)}` },
      { ...T, salt: `0x${"45".repeat(32)}` },
    ];
    for (const v of variants) expect(hashTerms(v, FACTORY)).not.toBe(base);
    expect(hashTerms(T, "0x00000000000000000000000000000000000f4c71")).not.toBe(base);
  });

  it("matches the independent encoding for random terms", () => {
    const hex32 = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((b) => `0x${Buffer.from(b).toString("hex")}` as Hex);
    const addr = fc
      .uint8Array({ minLength: 20, maxLength: 20 })
      .map((b) => getAddress(`0x${Buffer.from(b).toString("hex")}`));
    fc.assert(
      fc.property(
        fc.record({
          buyer: addr,
          seller: addr,
          operator: addr,
          token: addr,
          amount: fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }),
          dueAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          deadline: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          reviewWindow: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
          slaFloorBps: fc.integer({ min: 0, max: 65535 }),
          killFeeBps: fc.integer({ min: 0, max: 65535 }),
          keyHash: hex32,
          specHash: hex32,
          contentHash: hex32,
          salt: hex32,
        }),
        addr,
        (t, factory) => hashTerms(t, factory) === manualTermsHash(t, factory),
      ),
      { numRuns: 200 },
    );
  });
});

describe("vaultImplOf / escrowOf", () => {
  it("vaultImpl = keccak256(rlp([factory, 1]))[12:]", () => {
    const rlp = concat(["0xd694", FACTORY, "0x01"]);
    expect(vaultImplOf(FACTORY)).toBe(getAddress(slice(keccak256(rlp), 12)));
  });

  it("escrow = keccak256(0xff ‖ factory ‖ termsHash ‖ keccak256(initcode))[12:]", () => {
    const h = hashTerms(T, FACTORY);
    const impl = vaultImplOf(FACTORY);
    const initCode =
      `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
    const expected = getAddress(slice(keccak256(concat(["0xff", FACTORY, h, keccak256(initCode)])), 12));
    expect(escrowOf(h, FACTORY)).toBe(expected);
    expect(escrowOf(h, FACTORY, impl)).toBe(expected);
    expect(escrowOf(h, FACTORY, "0x000000000000000000000000000000000000dEaD")).not.toBe(expected);
  });

  it("rejects a malformed termsHash", () => {
    expect(() => escrowOf("0x1234", FACTORY)).toThrow(/termsHash/);
  });
});

describe("payoutAt", () => {
  it("frozen boundary behaviour", () => {
    expect(payoutAt(T, T.dueAt - 1)).toBe(4_000_000n);
    expect(payoutAt(T, T.dueAt)).toBe(4_000_000n);
    expect(payoutAt(T, (T.dueAt + T.deadline) / 2)).toBe(2_500_000n);
    expect(payoutAt(T, T.deadline)).toBe(1_000_000n);
    expect(payoutAt(T, BigInt(T.deadline) + 10n ** 30n)).toBe(1_000_000n);
    expect(payoutAt({ ...T, dueAt: 0 }, T.deadline + 1)).toBe(4_000_000n);
    expect(payoutAt({ ...T, slaFloorBps: 10000 }, T.deadline - 1)).toBe(4_000_000n);
  });

  it("reverts where Solidity would (floor > amount inside the decay)", () => {
    expect(() => payoutAt({ ...T, slaFloorBps: 10001 }, T.dueAt + 1)).toThrow(RangeError);
    expect(payoutAt({ ...T, slaFloorBps: 10001 }, T.deadline)).toBe(4_000_400n);
  });

  it("matches the reference formula; monotone non-increasing; never above amount", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.integer({ min: 0, max: 10000 }),
        fc.bigInt({ min: 0n, max: 2n ** 42n }),
        fc.bigInt({ min: 0n, max: 2n ** 30n }),
        (amount, dueAt, span, bps, ts, step) => {
          const t = { ...T, amount, dueAt, deadline: dueAt + span, slaFloorBps: bps };
          const p = payoutAt(t, ts);
          return p === refPayout(t, ts) && p <= amount && payoutAt(t, ts + step) <= p;
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("Terms JSON", () => {
  const json = termsToJson(T);

  it("round-trips and is canonical (§1)", () => {
    expect(json.amount).toBe("4000000");
    expect(json.token).toBe(USDC);
    expect(termsFromJson(json)).toEqual({ ...T, token: USDC });
    expect(termsToJson(termsFromJson(json))).toEqual(json);
    expect(termsToJson({ ...T, keyHash: `0x${"AB".repeat(32)}` }).keyHash).toBe(`0x${"ab".repeat(32)}`);
  });

  it.each([
    ["bad checksum", { buyer: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" }],
    ["lowercase non-checksummed address", { token: USDC.toLowerCase() }],
    ["uppercase bytes32", { salt: `0x${"AB".repeat(32)}` }],
    ["short bytes32", { salt: "0x1234" }],
    ["amount leading zero", { amount: "04000000" }],
    ["amount as number", { amount: 4000000 }],
    ["amount > uint256", { amount: (1n << 256n).toString() }],
    ["float deadline", { deadline: 1.5 }],
    ["negative dueAt", { dueAt: -1 }],
    ["unsafe deadline", { deadline: 2 ** 53 }],
    ["uint16 overflow", { slaFloorBps: 65536 }],
    ["uint32 overflow", { reviewWindow: 2 ** 32 }],
    ["unknown key", { extra: 1 }],
  ])("rejects %s", (_name, patch) => {
    expect(() => termsFromJson({ ...json, ...patch })).toThrow();
  });

  it("rejects a missing field", () => {
    const { salt: _salt, ...rest } = json;
    expect(() => termsFromJson(rest)).toThrow();
  });
});

describe("decisionTypedData", () => {
  it("hashes to keccak(0x1901 ‖ domain ‖ keccak(typehash ‖ termsHash ‖ accept ‖ deadline))", () => {
    const h = hashTerms(T, FACTORY);
    const td = decisionTypedData(h, false, 1_798_800_000, FACTORY);
    expect(td.primaryType).toBe("Decision");
    expect(td.message).toEqual({ termsHash: h, accept: false, deadline: 1_798_800_000n });
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint256" }],
        [keccak256(toBytes("Decision(bytes32 termsHash,bool accept,uint256 deadline)")), h, false, 1_798_800_000n],
      ),
    );
    expect(hashTypedData(td)).toBe(keccak256(concat(["0x1901", manualDomainSeparator(FACTORY), structHash])));
  });
});
