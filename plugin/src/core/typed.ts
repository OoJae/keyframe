// Guards for anything this plugin asks a user to sign. A compromised backend must not be able to turn a "review"
// into a USDC permit, a transfer authorization or a binding Decision, so: a Decision is accepted only under the
// Keyframe Escrow EIP-712 domain of this order's allowlisted factory on Base, with exactly the frozen type, and only
// if sanitizing it changes nothing (no check-then-sanitize gap); and the "changes" request is never taken from the
// backend at all: the plugin builds ChangeRequest(bytes32 termsHash,uint256 deadline) itself.

import { type Address, getAddress, type Hex, isAddress, isAddressEqual } from "viem";
import { CHAIN_ID, DECISION_TYPES, EIP712_NAME, EIP712_VERSION } from "../protocol/index.js";
import { ToolError } from "./result.js";
import { capJson, clean, quoted } from "./text.js";

export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Max lifetime of a signed review decision. */
export const MAX_SIG_LIFETIME_S = 7 * 86_400;

/** Lifetime of the plugin's own change-request message (Keyframe's API accepts up to 2 h ahead). */
export const CHANGE_SIG_TTL_S = 3_600;

/** Off-chain change request, verified by Keyframe's API only; the factory never accepts it as a Decision. */
export const CHANGE_REQUEST_TYPES = {
  ChangeRequest: [
    { name: "termsHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const domainOf = (factory: Address) => ({
  name: EIP712_NAME,
  version: EIP712_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: getAddress(factory),
});

/** JSON-safe EIP-712 Decision payload (eth_signTypedData_v4 shape; uint256 as decimal strings). */
export function decisionPayload(factory: Address, termsHash: Hex, accept: boolean, deadline: number) {
  return {
    types: { EIP712Domain: [...EIP712_DOMAIN_TYPE], Decision: [...DECISION_TYPES.Decision] },
    primaryType: "Decision",
    domain: domainOf(factory),
    message: { termsHash: termsHash.toLowerCase(), accept, deadline: String(deadline) },
  };
}

/** The plugin's own ChangeRequest payload for this order (same JSON shape as decisionPayload). */
export function changeRequestPayload(factory: Address, termsHash: Hex, deadline: number) {
  return {
    types: { EIP712Domain: [...EIP712_DOMAIN_TYPE], ChangeRequest: [...CHANGE_REQUEST_TYPES.ChangeRequest] },
    primaryType: "ChangeRequest",
    domain: domainOf(factory),
    message: { termsHash: termsHash.toLowerCase(), deadline: String(deadline) },
  };
}

/** viem form of the change request (for local signer recovery). */
export const changeRequestTypedData = (factory: Address, termsHash: Hex, deadline: number) => ({
  domain: domainOf(factory),
  types: CHANGE_REQUEST_TYPES,
  primaryType: "ChangeRequest" as const,
  message: { termsHash, deadline: BigInt(deadline) },
});

function sameFields(a: unknown, b: readonly { name: string; type: string }[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((f, i) => typeof f === "object" && f !== null && f.name === b[i]?.name && f.type === b[i]?.type);
}

/** Case-, width- and invisible-character-insensitive form of a type name, to spot look-alikes of a frozen type. */
const lookalike = (name: string): string => clean(name.normalize("NFKC"), 200).replace(/\s+/g, "").toLowerCase();
const RESERVED = ["decision", "eip712domain"];

export type CheckedTypedData = { primaryType: string; deadline: number };

const SANITIZE_CAPS = { maxString: 500, maxArray: 32, maxKeys: 32, maxDepth: 6 };

/**
 * Validates backend typed data for an accept/reject Decision and returns its deadline. Throws ToolError with the
 * reason on anything unexpected. Every backend value in a refusal is quoted as data.
 */
export function checkReviewTypedData(
  td: unknown,
  expected: { factories: readonly Address[]; factory: Address; termsHash: Hex; accept: boolean; now: number },
): CheckedTypedData {
  const refuse = (why: string): never => {
    throw new ToolError(
      `Refusing to ask you to sign: the message from Keyframe's API is not a Keyframe review decision (${why}). Nothing was signed and no money moved.`,
    );
  };
  if (typeof td !== "object" || td === null || Array.isArray(td)) return refuse("not an object");
  const raw = JSON.stringify(td);
  if (raw.length > 8_192) return refuse("too large");
  // H2: validate exactly what would be shown and signed. If the sanitizer would change anything (trailing spaces,
  // zero-width or control characters, oversized values), refuse instead of checking one thing and passing another.
  if (JSON.stringify(capJson(td, SANITIZE_CAPS)) !== raw) {
    return refuse("it contains hidden characters or non-canonical values");
  }
  const { domain, types, primaryType, message } = td as Record<string, unknown>;
  if (typeof domain !== "object" || domain === null) return refuse("no domain");
  const d = domain as Record<string, unknown>;
  if (d.name !== EIP712_NAME || d.version !== EIP712_VERSION) return refuse("not the Keyframe Escrow domain");
  if (Number(d.chainId) !== CHAIN_ID) return refuse("not Base");
  if (typeof d.verifyingContract !== "string" || !isAddress(d.verifyingContract, { strict: false }))
    return refuse("no verifying contract");
  const vc = d.verifyingContract as Address;
  if (!expected.factories.some((f) => isAddressEqual(f, vc)) || !isAddressEqual(vc, expected.factory)) {
    return refuse("not this order's allowlisted escrow factory");
  }
  for (const k of Object.keys(d))
    if (!["name", "version", "chainId", "verifyingContract"].includes(k))
      return refuse(`unexpected domain field ${quoted(k)}`);
  if (typeof types !== "object" || types === null || typeof primaryType !== "string") return refuse("no types");
  const t = types as Record<string, unknown>;
  for (const name of [primaryType, ...Object.keys(t)]) {
    if (name !== "Decision" && name !== "EIP712Domain" && RESERVED.includes(lookalike(name))) {
      return refuse(`type ${quoted(name)} is a look-alike of a Keyframe type`);
    }
  }
  if ("EIP712Domain" in t && !sameFields(t.EIP712Domain, EIP712_DOMAIN_TYPE)) return refuse("non-standard domain type");
  if (typeof message !== "object" || message === null) return refuse("no message");
  const m = message as Record<string, unknown>;
  if (typeof m.termsHash !== "string" || m.termsHash.toLowerCase() !== expected.termsHash.toLowerCase()) {
    return refuse("it is not about this order");
  }
  if (primaryType !== "Decision") return refuse(`type ${quoted(primaryType)}`);
  const extraTypes = Object.keys(t).filter((k) => k !== "Decision" && k !== "EIP712Domain");
  if (!sameFields(t.Decision, DECISION_TYPES.Decision) || extraTypes.length > 0)
    return refuse("non-standard Decision type");
  for (const k of Object.keys(m))
    if (!["termsHash", "accept", "deadline"].includes(k)) return refuse(`unexpected message field ${quoted(k)}`);
  if (m.accept !== expected.accept)
    return refuse(expected.accept ? "it would reject, not accept" : "it would accept, not reject");
  const deadline = Number(m.deadline);
  if (!Number.isSafeInteger(deadline) || deadline <= expected.now || deadline > expected.now + MAX_SIG_LIFETIME_S) {
    return refuse("its deadline is not within the next 7 days");
  }
  return { primaryType, deadline };
}
