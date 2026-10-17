// Guards for anything this plugin asks a user to sign. A compromised backend must not be able to turn a "review"
// into a USDC permit or transfer authorization, so typed data is accepted only under the Keyframe Escrow EIP-712
// domain of an allowlisted factory on Base, and a Decision must be exactly the frozen type for this order.

import { type Address, getAddress, type Hex, isAddress, isAddressEqual } from "viem";
import { CHAIN_ID, DECISION_TYPES, EIP712_NAME, EIP712_VERSION } from "../protocol/index.js";
import { ToolError } from "./result.js";

export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Max lifetime of a signed review decision. */
export const MAX_SIG_LIFETIME_S = 7 * 86_400;

/** JSON-safe EIP-712 Decision payload (eth_signTypedData_v4 shape; uint256 as decimal strings). */
export function decisionPayload(factory: Address, termsHash: Hex, accept: boolean, deadline: number) {
  return {
    types: { EIP712Domain: [...EIP712_DOMAIN_TYPE], Decision: [...DECISION_TYPES.Decision] },
    primaryType: "Decision",
    domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId: CHAIN_ID, verifyingContract: getAddress(factory) },
    message: { termsHash: termsHash.toLowerCase(), accept, deadline: String(deadline) },
  };
}

const SOLIDITY_TYPE =
  /^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)(\[\d{0,3}\])?$/;

function sameFields(a: unknown, b: readonly { name: string; type: string }[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((f, i) => typeof f === "object" && f !== null && f.name === b[i]?.name && f.type === b[i]?.type);
}

export type CheckedTypedData = { primaryType: string; deadline: number | null };

/**
 * Validates backend typed data for a review decision. Throws ToolError with the reason on anything unexpected.
 * `expected.accept` is null for "changes" (an off-chain request; the factory never acts on it).
 */
export function checkReviewTypedData(
  td: unknown,
  expected: { factories: readonly Address[]; factory: Address; termsHash: Hex; accept: boolean | null; now: number },
): CheckedTypedData {
  const refuse = (why: string): never => {
    throw new ToolError(
      `Refusing to ask you to sign: the message from Keyframe's API is not a Keyframe review decision (${why}). Nothing was signed and no money moved.`,
    );
  };
  if (typeof td !== "object" || td === null || Array.isArray(td)) return refuse("not an object");
  if (JSON.stringify(td).length > 8_192) return refuse("too large");
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
    if (!["name", "version", "chainId", "verifyingContract"].includes(k)) return refuse(`unexpected domain field ${k}`);
  if (typeof types !== "object" || types === null || typeof primaryType !== "string") return refuse("no types");
  const t = types as Record<string, unknown>;
  if ("EIP712Domain" in t && !sameFields(t.EIP712Domain, EIP712_DOMAIN_TYPE)) return refuse("non-standard domain type");
  if (typeof message !== "object" || message === null) return refuse("no message");
  const m = message as Record<string, unknown>;
  if (typeof m.termsHash !== "string" || m.termsHash.toLowerCase() !== expected.termsHash.toLowerCase()) {
    return refuse("it is not about this order");
  }

  if (expected.accept !== null) {
    if (primaryType !== "Decision") return refuse(`type ${primaryType}`);
    const extraTypes = Object.keys(t).filter((k) => k !== "Decision" && k !== "EIP712Domain");
    if (!sameFields(t.Decision, DECISION_TYPES.Decision) || extraTypes.length > 0)
      return refuse("non-standard Decision type");
    if (m.accept !== expected.accept)
      return refuse(expected.accept ? "it would reject, not accept" : "it would accept, not reject");
    const deadline = Number(m.deadline);
    if (!Number.isSafeInteger(deadline) || deadline <= expected.now || deadline > expected.now + MAX_SIG_LIFETIME_S) {
      return refuse("its deadline is not within the next 7 days");
    }
    return { primaryType, deadline };
  }

  // "changes": any other struct under the Keyframe domain. The factory only ever verifies Decision signatures,
  // so this signature cannot move money; it only authenticates the request to Keyframe's API.
  if (primaryType === "Decision") return refuse("a change request must not be a Decision");
  for (const [name, fields] of Object.entries(t)) {
    if (!Array.isArray(fields) || fields.length > 16) return refuse(`bad type ${name}`);
    for (const f of fields as { name?: unknown; type?: unknown }[]) {
      if (typeof f?.name !== "string" || typeof f.type !== "string") return refuse(`bad field in ${name}`);
      if (!SOLIDITY_TYPE.test(f.type) && !(f.type in t)) return refuse(`unknown field type ${f.type}`);
    }
  }
  if (!(primaryType in t)) return refuse("primary type not defined");
  const deadline = m.deadline === undefined ? null : Number(m.deadline);
  return { primaryType, deadline: deadline !== null && Number.isSafeInteger(deadline) ? deadline : null };
}
