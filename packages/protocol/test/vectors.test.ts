// Cross-language parity vectors. Reads the shared input (docs/design/vectors/terms-v1.input.json) and produces
// test/vectors/terms-v1.output.json; contracts/ computes the same values independently and an integration step
// diffs the two. Regenerate with `pnpm -F @keyframe/protocol vectors`; plain `vitest` asserts the committed file.
import { createHash, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Address, getAddress, type Hex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { encryptKfc1, escrowOf, hashTerms, payoutAt, termsFromJson, vaultImplOf } from "../src/index.js";
import { patternBytes, REPO_ROOT, VECTOR_INPUT, VECTOR_OUTPUT } from "./helpers.js";

type Input = {
  v: number;
  chainId: number;
  factory: string;
  usdc: string;
  terms: Record<string, unknown>[];
  payoutSamples: { termsIndex: number; ts: number }[];
  kfc1: { kChain: Hex; kBuyer: Hex; salt: Hex; plaintextBytes: number; plaintextPattern: string };
};

// The input does not pin manifest media; the frozen §5 example values are used and recorded in the output.
const KFC1_VECTOR_MEDIA = { mime: "video/mp4", width: 1080, height: 1920, durationMs: 6000, fps: 30 };

// Some input addresses are not valid EIP-55 (mixed case with a wrong checksum). Address case never affects
// the ABI/EIP-712 encoding, so they are normalised here; termsFromJson itself stays strict (§1).
const ADDRESS_KEYS = ["buyer", "seller", "operator", "token"] as const;
const normaliseAddresses = (t: Record<string, unknown>) => {
  const out = { ...t };
  for (const k of ADDRESS_KEYS) out[k] = getAddress(String(t[k]).toLowerCase());
  return out;
};

async function computeVectors() {
  const raw = readFileSync(VECTOR_INPUT);
  const input = JSON.parse(raw.toString("utf8")) as Input;
  expect(input.v).toBe(1);
  expect(input.chainId).toBe(8453);
  const factory = getAddress(input.factory.toLowerCase()) as Address;
  const vaultImpl = vaultImplOf(factory);
  const terms = input.terms.map((t) => termsFromJson(normaliseAddresses(t)));

  const termsOut = terms.map((t, index) => {
    const termsHash = hashTerms(t, factory);
    return { index, termsHash, vaultImpl, escrow: escrowOf(termsHash, factory, vaultImpl) };
  });
  const payoutOut = input.payoutSamples.map(({ termsIndex, ts }) => {
    const t = terms[termsIndex];
    if (!t) throw new Error(`payout sample references missing terms[${termsIndex}]`);
    return { termsIndex, ts, payoutAt: payoutAt(t, ts).toString() };
  });

  const k = input.kfc1;
  expect(k.plaintextPattern).toBe("byte i = i mod 251");
  const enc = await encryptKfc1(patternBytes(k.plaintextBytes), {
    kChain: k.kChain,
    kBuyer: k.kBuyer,
    salt: k.salt,
    media: KFC1_VECTOR_MEDIA,
  });
  // K_file via node:crypto (independent of the WebCrypto path) so other-language decryptors can check HKDF alone.
  const ikm = new Uint8Array([...hexToBytes(k.kChain), ...hexToBytes(k.kBuyer)]);
  const fileKey = `0x${Buffer.from(hkdfSync("sha256", ikm, hexToBytes(k.salt), Buffer.from("keyframe/kfc1/file"), 32)).toString("hex")}`;

  return {
    v: 1,
    producer: "packages/protocol (viem 2.51.3, WebCrypto)",
    input: path.relative(REPO_ROOT, VECTOR_INPUT),
    inputSha256: `0x${createHash("sha256").update(raw).digest("hex")}`,
    chainId: input.chainId,
    factory,
    terms: termsOut,
    payoutSamples: payoutOut,
    kfc1: {
      media: KFC1_VECTOR_MEDIA,
      fileKey,
      chunks: enc.manifest.chunks,
      ciphertextSha256: enc.manifest.ciphertext,
      plaintextSha256: enc.manifest.plaintextSha256,
      manifestHash: enc.manifestHash,
      manifest: enc.manifest,
    },
  };
}

describe("terms-v1 parity vectors", () => {
  it("output file matches a fresh computation", async () => {
    const text = `${JSON.stringify(await computeVectors(), null, 2)}\n`;
    if (process.env.KEYFRAME_WRITE_VECTORS === "1") {
      writeFileSync(VECTOR_OUTPUT, text);
    } else {
      expect(existsSync(VECTOR_OUTPUT), `${VECTOR_OUTPUT} missing: run pnpm -F @keyframe/protocol vectors`).toBe(true);
      expect(readFileSync(VECTOR_OUTPUT, "utf8")).toBe(text);
    }
  });
});
