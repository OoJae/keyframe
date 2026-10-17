// The deal ("terms") as the plugin sees it: lenient-but-safe parsing of agent-supplied Terms JSON, local escrow
// derivation (§1-§2), the factory's validity rules that can be checked offline, and the env allowlist checks.

import { type Address, concat, getAddress, type Hex, isAddress, keccak256 } from "viem";
import {
  CHAIN_ID,
  CLONE_PREFIX,
  CLONE_SUFFIX,
  escrowOf,
  hashTerms,
  MAX_AMOUNT,
  MIN_AMOUNT,
  payoutAt,
  type Terms,
  type TermsJson,
  termsFromJson,
  termsToJson,
  USDC,
  vaultImplOf,
} from "../protocol/index.js";
import { type Check, fail, pass, warn } from "./checks.js";
import { type Config, type EnvName, findFactory, inList } from "./config.js";
import { ToolError } from "./result.js";
import { quoted, shortAddr, usdc, utc } from "./text.js";

export const ZERO32 = `0x${"0".repeat(64)}` as Hex;
export const MAX_LIFETIME_S = 30 * 86_400;
export const RELEASE_GRACE_S = 3 * 86_400;
/** Plugin safety bound on how long a new payment may stay locked before it can be refunded. */
export const MAX_LOCK_S = 7 * 86_400;
/** Hard bounds for a NEW payment, matching the factory's caps (MAX_REVIEW_WINDOW = 14 days, killFeeBps <= 5000). */
export const MAX_REVIEW_WINDOW_S = 14 * 86_400;
export const MAX_KILL_FEE_BPS = 5_000;

export const DERIVATION_FORMULA =
  "termsHash = EIP-712 hash of Terms under {name: Keyframe Escrow, version: 1, chainId: 8453, verifyingContract: factory}; " +
  "vault_impl = CREATE(factory, nonce 1); escrow = CREATE2(factory, salt = termsHash, keccak256(EIP-1167 init code of vault_impl))";

export type Derivation = {
  factory: Address;
  vault_impl: Address;
  vault_impl_source: "argument" | "factory_nonce_1";
  init_code_hash: Hex;
  salt: Hex;
  chain_id: number;
  formula: string;
};

export type Derived = { termsHash: Hex; escrow: Address; derivation: Derivation };

/** Pure: termsHash, vault implementation, clone init-code hash and escrow address. */
export function derive(t: Terms, factory: Address, vaultImpl?: Address): Derived {
  const impl = vaultImpl ?? vaultImplOf(factory);
  const termsHash = hashTerms(t, factory);
  return {
    termsHash,
    escrow: escrowOf(termsHash, factory, impl),
    derivation: {
      factory: getAddress(factory),
      vault_impl: getAddress(impl),
      vault_impl_source: vaultImpl === undefined ? "factory_nonce_1" : "argument",
      init_code_hash: keccak256(concat([CLONE_PREFIX, getAddress(impl), CLONE_SUFFIX])),
      salt: termsHash,
      chain_id: CHAIN_ID,
      formula: DERIVATION_FORMULA,
    },
  };
}

/** An agent-supplied address: any single case, or mixed case with a valid EIP-55 checksum (else likely a typo). */
export function inputAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new ToolError(`${field} is not a 20-byte hex address.`);
  }
  const body = value.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && getAddress(value) !== value) {
    throw new ToolError(`${field} has an invalid EIP-55 checksum (a typo?); copy the address exactly.`);
  }
  return getAddress(value);
}

/**
 * Terms JSON from an agent or the API. Addresses may be lower/upper case or checksummed (a wrong mixed-case
 * checksum is rejected); bytes32 may be any case. Case never changes the hash. Everything else is strict.
 */
export function parseTerms(raw: unknown): Terms {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ToolError("terms must be an object.");
  const r = raw as Record<string, unknown>;
  const norm: Record<string, unknown> = { ...r };
  for (const f of ["buyer", "seller", "operator", "token"] as const) norm[f] = inputAddress(r[f], `terms.${f}`);
  for (const f of ["keyHash", "specHash", "contentHash", "salt"] as const) {
    norm[f] = typeof r[f] === "string" ? (r[f] as string).toLowerCase() : r[f];
  }
  try {
    return termsFromJson(norm);
  } catch (error) {
    const issue = (error as { issues?: { path?: unknown[]; message?: string }[] }).issues?.[0];
    const where = issue?.path?.length ? `terms.${issue.path.join(".")}` : "terms";
    throw new ToolError(`${quoted(where, 60)} is invalid (${quoted(issue?.message ?? "bad value", 120)}).`);
  }
}

export const termsJson = (t: Terms): TermsJson => termsToJson(t);

/** The factory's valid(T) rules that need neither config nor a clock, plus the tier convention for contentHash. */
export function shapeChecks(t: Terms): Check[] {
  const checks: Check[] = [];
  const problems: string[] = [];
  if (t.token.toLowerCase() !== USDC.toLowerCase()) problems.push(`token ${t.token} is not Base USDC`);
  if (t.amount < MIN_AMOUNT || t.amount > MAX_AMOUNT)
    problems.push(`amount ${usdc(t.amount)} USDC is outside 0.10-50.00`);
  if (/^0x0{40}$/i.test(t.buyer)) problems.push("buyer is the zero address");
  if (/^0x0{40}$/i.test(t.operator)) problems.push("operator is the zero address");
  if (t.slaFloorBps > 10_000 || t.killFeeBps > 10_000) problems.push("a basis-point field exceeds 10000");
  if (t.dueAt !== 0 && t.dueAt >= t.deadline) problems.push("dueAt is not before the deadline");
  checks.push(
    problems.length === 0
      ? pass(
          "terms_valid",
          `the deal passes the escrow factory's validity rules (USDC, ${usdc(t.amount)} USDC within 0.10-50.00)`,
        )
      : fail("terms_valid", `the escrow factory would reject this deal: ${problems.join("; ")}`),
  );
  const instant = t.reviewWindow === 0;
  if (instant && t.contentHash === ZERO32) {
    checks.push(warn("content_bound", "Instant deal without a contentHash: payment is not bound to a specific file"));
  } else if (!instant && t.contentHash !== ZERO32) {
    checks.push(warn("content_bound", "Studio deal with a non-zero contentHash (Studio binds the file at delivery)"));
  } else {
    checks.push(
      pass(
        "content_bound",
        instant
          ? "Instant deal: payment is bound to the exact encrypted file (contentHash = manifest hash)"
          : "Studio deal: the file is bound at delivery, then reviewed",
      ),
    );
  }
  return checks;
}

/**
 * Payment-only bounds (not refunds: an older factory's deals must stay refundable): the review window is at most
 * 14 days and the kill fee at most 50%, the caps the escrow factory enforces.
 */
export function dealBoundsCheck(t: Terms): Check {
  const problems: string[] = [];
  if (t.reviewWindow > MAX_REVIEW_WINDOW_S)
    problems.push(`the review window is ${Math.round(t.reviewWindow / 3600)} h, more than 14 days`);
  if (t.killFeeBps > MAX_KILL_FEE_BPS)
    problems.push(`the kill fee is ${(t.killFeeBps / 100).toFixed(2)}% of the price, more than 50%`);
  return problems.length === 0
    ? pass(
        "deal_bounds",
        `review window ${Math.round(t.reviewWindow / 3600)} h (at most 14 days) and kill fee ${(t.killFeeBps / 100).toFixed(2)}% (at most 50%)`,
      )
    : fail("deal_bounds", `this plugin pays only deals within the escrow's caps: ${problems.join("; ")}`);
}

/** Plain-English payout schedule (pure). */
export function payoutSummary(t: Terms): { at_due: string; at_deadline: string; text: string } {
  const atDue = payoutAt(t, t.dueAt === 0 ? 0 : t.dueAt).toString();
  let atDeadline: string;
  try {
    atDeadline = payoutAt(t, t.deadline).toString();
  } catch {
    atDeadline = atDue;
  }
  const text =
    t.dueAt === 0 || atDeadline === atDue
      ? `the studio can be paid at most ${usdc(t.amount)} USDC, only by publishing the key before the deadline`
      : `full ${usdc(t.amount)} USDC if delivered by ${utc(t.dueAt)}, decaying to ${usdc(atDeadline)} USDC at the deadline; the rest returns to the buyer`;
  return { at_due: atDue, at_deadline: atDeadline, text };
}

const configProblem = (cfg: Config, names: EnvName[]): EnvName | undefined =>
  names.find((n) => cfg.problems.includes(n));

/**
 * Env allowlist checks before a proposal (§8). "pay" requires an active factory and allowlisted seller/operator
 * and the amount cap; "refund" only requires a known factory (funds can only reach T.buyer).
 */
export function allowlistChecks(cfg: Config, t: Terms, factory: Address, purpose: "pay" | "refund"): Check[] {
  const checks: Check[] = [];
  const bad = configProblem(cfg, ["KEYFRAME_FACTORIES"]);
  const entry = findFactory(cfg, factory);
  if (bad) checks.push(fail("factory_allowlisted", `${bad} is not valid configuration; the plugin trusts no factory`));
  else if (!entry) {
    checks.push(fail("factory_allowlisted", `escrow factory ${shortAddr(factory)} is not in KEYFRAME_FACTORIES`));
  } else if (purpose === "pay" && entry.status !== "active") {
    checks.push(
      fail("factory_allowlisted", `escrow factory ${shortAddr(factory)} is refund-only; it takes no new payments`),
    );
  } else {
    checks.push(pass("factory_allowlisted", `escrow factory ${shortAddr(factory)} is allowlisted (${entry.status})`));
  }
  if (purpose === "refund") return checks;

  const sellerBad = configProblem(cfg, ["KEYFRAME_SELLERS"]);
  checks.push(
    !sellerBad && inList(cfg.sellers, t.seller)
      ? pass("seller_allowlisted", `payout address ${shortAddr(t.seller)} is Keyframe's allowlisted studio wallet`)
      : fail("seller_allowlisted", `payout address ${shortAddr(t.seller)} is not in KEYFRAME_SELLERS`),
  );
  const opBad = configProblem(cfg, ["KEYFRAME_OPERATORS"]);
  checks.push(
    !opBad && inList(cfg.operators, t.operator)
      ? pass(
          "operator_allowlisted",
          `operator ${shortAddr(t.operator)} is allowlisted (it can deliver or void, never redirect funds)`,
        )
      : fail("operator_allowlisted", `operator ${shortAddr(t.operator)} is not in KEYFRAME_OPERATORS`),
  );
  const capBad = configProblem(cfg, ["KEYFRAME_MAX_AMOUNT"]);
  checks.push(
    !capBad && t.amount <= cfg.maxAmount
      ? pass("amount_cap", `${usdc(t.amount)} USDC is within this plugin's cap of ${usdc(cfg.maxAmount)} USDC`)
      : fail(
          "amount_cap",
          `${usdc(t.amount)} USDC exceeds this plugin's cap (KEYFRAME_MAX_AMOUNT, at most 50.00 USDC)`,
        ),
  );
  return checks;
}
