// Resolves which deal a request is about, from whatever the agent has: Terms JSON, the paid response (or a whole
// get_request result), a quote_id, an order_id or a bare terms_hash. Terms from the API are labelled "api" and are
// always re-hashed; every claimed hash/address is compared with the local derivation. Only allowlisted factories
// (any status) are ever used, so a proposal can only target Keyframe's own escrow contract.

import { type Address, getAddress, type Hex, isAddressEqual } from "viem";
import { escrowOf, type Quote, type Spec, SpecSchema, specHash, type Terms } from "../protocol/index.js";
import { ACCESS_TOKEN_RE, apiFailure, apiRequest, getQuote, ORDER_ID_RE, QUOTE_ID_RE } from "./api.js";
import { type Check, fail, pass } from "./checks.js";
import type { Config, FactoryEntry } from "./config.js";
import { findFactory } from "./config.js";
import { type Derived, derive, parseTerms, RELEASE_GRACE_S, shapeChecks } from "./deal.js";
import type { Budget } from "./net.js";
import { ToolError } from "./result.js";
import { capRecord, quoted, shortAddr } from "./text.js";

/** Keyframe's paid path answered `charged: "unknown"`: the payment may be settling. Never invite a second one. */
export const SETTLING_TEXT =
  'Keyframe reports the payment outcome as unknown (charged: "unknown"): it is still being settled. Do not pay again and do not sign a new payment; poll keyframe_status with the quote_id until the quote is paid, then call keyframe_verify with mode "funding".';

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type PaidRef = {
  order_id?: string;
  access_token?: string;
  quote_id?: string;
  terms_hash?: Hex;
  escrow?: Address;
  amount?: bigint;
  funding_tx?: Hex;
  k_buyer?: Hex;
  /** What Keyframe says about the money: false = refused before settlement, true = settled, "unknown" = settling. */
  charged?: boolean | "unknown";
  /** Keyframe's machine-readable error code on a non-200 paid response (e.g. settlement_in_progress). */
  error?: string;
  /** A later replay of a settled payment: access_token / k_buyer are null by design (recover with keyframe_orders). */
  secrets_withheld?: boolean;
  /** HTTP 429: the request was rate limited and not processed. */
  rate_limited?: boolean;
  /** Keyframe's watch page for the order; shown only if it passes the own-host guard (core/links.ts). */
  watch_url?: string;
};

const str = (o: Record<string, unknown>, k: string, re: RegExp): string | undefined =>
  typeof o[k] === "string" && re.test(o[k] as string) ? (o[k] as string) : undefined;

const POLL_QUOTE_RE = /^\/v1\/quotes\/(q_[1-9A-HJ-NP-Za-km-z]{22})$/;

/**
 * A Keyframe paid response, in any of its shapes: the 200 paid body (access_token / k_buyer may be null on a
 * later replay, with secrets_withheld), 503 settlement_recording_delayed (charged true, order_id), 409
 * settlement_in_progress (charged "unknown", the quote only in `poll`), a refusal (charged false) or a 429.
 * Fields are taken one by one and only when well-formed; nothing here fails on a null.
 */
function asPaid(o: Record<string, unknown>): PaidRef | null {
  const poll = typeof o.poll === "string" ? POLL_QUOTE_RE.exec(o.poll)?.[1] : undefined;
  const ref: PaidRef = {
    order_id: str(o, "order_id", ORDER_ID_RE),
    access_token: str(o, "access_token", ACCESS_TOKEN_RE),
    quote_id: str(o, "quote_id", QUOTE_ID_RE) ?? poll,
    terms_hash: str(o, "terms_hash", BYTES32)?.toLowerCase() as Hex | undefined,
    escrow: str(o, "escrow", ADDRESS) as Address | undefined,
    funding_tx: str(o, "funding_tx", BYTES32)?.toLowerCase() as Hex | undefined,
    k_buyer: str(o, "k_buyer", BYTES32)?.toLowerCase() as Hex | undefined,
  };
  const amount = str(o, "amount", /^[1-9][0-9]{0,77}$/);
  if (amount) ref.amount = BigInt(amount);
  if (o.charged === true || o.charged === false || o.charged === "unknown") ref.charged = o.charged;
  const error = str(o, "error", /^[a-z][a-z0-9_]{0,63}$/);
  if (error) ref.error = error;
  if (o.secrets_withheld === true) ref.secrets_withheld = true;
  if (error === "rate_limited" && o.processed === false) ref.rate_limited = true;
  if (typeof o.watch_url === "string" && o.watch_url.length <= 600) ref.watch_url = o.watch_url;
  return ref.order_id || ref.terms_hash || ref.charged !== undefined || ref.rate_limited ? ref : null;
}

/** Finds the paid body inside a paid response or a get_request result (bounded depth, JSON strings unwrapped). */
export function findPaid(value: unknown, depth = 0): PaidRef | null {
  if (depth > 5) return null;
  if (typeof value === "string" && depth > 0 && value.length < 64 * 1024 && value.trimStart().startsWith("{")) {
    try {
      return findPaid(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 32)) {
      const r = findPaid(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const direct = asPaid(value as Record<string, unknown>);
  if (direct) return direct;
  for (const v of Object.values(value as Record<string, unknown>).slice(0, 64)) {
    const r = findPaid(v, depth + 1);
    if (r) return r;
  }
  return null;
}

export type Resolved = {
  source: "argument" | "api" | "none";
  terms: Terms | null;
  factory: FactoryEntry;
  termsHash: Hex;
  escrow: Address;
  derived: Derived | null;
  quote: Quote | null;
  spec: Spec | null;
  order: Record<string, unknown> | null;
  paid: PaidRef | null;
  checks: Check[];
};

export type ResolveInput = {
  terms?: unknown;
  factory?: string;
  vault_impl?: string;
  terms_hash?: string;
  escrow?: string;
  quote_id?: string;
  order_id?: string;
  access_token?: string;
  paid_response?: unknown;
};

/** A Studio change request as Keyframe's order view reports it (`changes`), or null when there is none. */
export type Changes = {
  requestedAt: number;
  /** Keyframe's `changes.accept_by`, never later than the on-chain review end + the 3-day release grace. */
  acceptBy: number | null;
  revisionDelivered: boolean;
  /** Keyframe's own policy text: data, shown quoted. */
  policy: string | null;
};

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * Reads `changes {requested_at, accept_by, revision, policy}` from an order record. `reviewEnd` is the on-chain
 * review end (deliveredAt + reviewWindow): accept_by is clamped to reviewEnd + grace, the last moment Keyframe can
 * still release, so a backend cannot stretch the window in which the plugin asks for a signature.
 */
export function changesOf(order: Record<string, unknown> | null, reviewEnd: number | null): Changes | null {
  const c = order?.changes;
  if (typeof c !== "object" || c === null || Array.isArray(c)) return null;
  const x = c as Record<string, unknown>;
  const requestedAt = posInt(x.requested_at);
  if (requestedAt === null) return null;
  const raw = posInt(x.accept_by);
  const acceptBy = raw === null || reviewEnd === null ? null : Math.min(raw, reviewEnd + RELEASE_GRACE_S);
  return {
    requestedAt,
    acceptBy,
    revisionDelivered: typeof x.revision === "object" && x.revision !== null,
    policy: typeof x.policy === "string" && x.policy.trim() !== "" ? x.policy : null,
  };
}

/**
 * M3: the brief (spec) from Keyframe's API, only if it is exactly the one the deal commits to
 * (sha256(JCS(spec)) == T.specHash). Without terms, or on any mismatch, there is no trusted brief (null).
 */
export async function boundSpec(spec: unknown, terms: Terms | null): Promise<Spec | null> {
  if (!terms || typeof spec !== "object" || spec === null) return null;
  const s = SpecSchema.safeParse(spec);
  if (!s.success) return null;
  try {
    return (await specHash(s.data)) === terms.specHash.toLowerCase() ? s.data : null;
  } catch {
    return null;
  }
}

export async function fetchOrder(
  cfg: Config,
  budget: Budget,
  orderId: string,
  token: string | undefined,
  tail: string,
): Promise<Record<string, unknown>> {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const res = await apiRequest(cfg, budget, `/v1/orders/${orderId}${q}`, {}, "Fetching the order from Keyframe's API");
  if (res.status !== 200) throw apiFailure(res, tail);
  if (typeof res.json !== "object" || res.json === null || Array.isArray(res.json)) {
    throw new ToolError(`Keyframe returned an unreadable order record. ${tail}`);
  }
  return res.json as Record<string, unknown>;
}

function pickFactory(
  cfg: Config,
  named: string | undefined,
  termsHash: Hex | null,
  escrow: Address | undefined,
  tail: string,
) {
  if (named !== undefined) {
    const entry = findFactory(cfg, named);
    if (!entry)
      throw new ToolError(
        `Escrow factory ${shortAddr(named)} is not in KEYFRAME_FACTORIES, so this plugin will not use it. ${tail}`,
      );
    return entry;
  }
  if (termsHash && escrow) {
    const match = cfg.factories.find((f) => isAddressEqual(escrowOf(termsHash, f.address, f.vaultImpl), escrow));
    if (match) return match;
    throw new ToolError(`Escrow ${shortAddr(escrow)} does not belong to any allowlisted Keyframe factory. ${tail}`);
  }
  if (cfg.factories.length === 1 && cfg.factories[0]) return cfg.factories[0];
  if (cfg.factories.length === 0) throw new ToolError(`No escrow factory is configured (KEYFRAME_FACTORIES). ${tail}`);
  throw new ToolError(`Several escrow factories are configured; pass factory (it is in the quote). ${tail}`);
}

export async function resolveOrder(cfg: Config, budget: Budget, input: ResolveInput, tail: string): Promise<Resolved> {
  const paid = input.paid_response === undefined ? null : findPaid(input.paid_response);
  if (input.paid_response !== undefined && !paid) {
    throw new ToolError(`paid_response does not contain a Keyframe paid body (order_id, terms_hash). ${tail}`);
  }
  const quoteId = input.quote_id ?? paid?.quote_id;
  const orderId = input.order_id ?? paid?.order_id;
  const token = input.access_token ?? paid?.access_token;
  const otherRef = input.terms !== undefined || input.terms_hash !== undefined || quoteId || orderId;
  if (paid && !paid.order_id && !paid.terms_hash && !otherRef) {
    // A paid response without a deal in it: say what it means for the money, never "failed, pay again".
    if (paid.rate_limited) {
      throw new ToolError(
        `Keyframe rate-limited that payment request (HTTP 429): it was not processed. Do not sign a new payment; first check keyframe_status with the quote_id (an earlier attempt may still be settling). ${tail}`,
      );
    }
    if (paid.charged === "unknown")
      throw new ToolError(`${SETTLING_TEXT} Pass the quote_id to keyframe_status. ${tail}`);
    if (paid.charged === false) {
      throw new ToolError(
        `Keyframe refused that payment before settling it (charged: false${paid.error ? `, ${quoted(paid.error)}` : ""}): no money moved. Check keyframe_status with the quote_id before anything else. ${tail}`,
      );
    }
  }

  let terms: Terms | null = input.terms === undefined ? null : parseTerms(input.terms);
  let source: Resolved["source"] = terms ? "argument" : "none";
  let quote: Quote | null = null;
  let order: Record<string, unknown> | null = null;
  let factoryName = input.factory;

  if (!terms && quoteId) {
    quote = await getQuote(cfg, budget, quoteId, tail);
    terms = parseTerms(quote.terms);
    source = "api";
    factoryName ??= quote.factory;
  } else if (!terms && orderId) {
    order = await fetchOrder(cfg, budget, orderId, token, tail);
    if (typeof order.terms === "object" && order.terms !== null) {
      terms = parseTerms(order.terms);
      source = "api";
    }
    if (typeof order.factory === "string" && ADDRESS.test(order.factory)) factoryName ??= order.factory;
  }

  const claimedHash = (
    input.terms_hash ??
    paid?.terms_hash ??
    quote?.terms_hash ??
    (typeof order?.terms_hash === "string" && BYTES32.test(order.terms_hash) ? order.terms_hash : undefined)
  )?.toLowerCase() as Hex | undefined;
  const claimedEscrowRaw =
    input.escrow ?? paid?.escrow ?? quote?.escrow ?? (typeof order?.escrow === "string" ? order.escrow : undefined);
  const claimedEscrow = claimedEscrowRaw && ADDRESS.test(claimedEscrowRaw) ? getAddress(claimedEscrowRaw) : undefined;

  if (!terms && !claimedHash)
    throw new ToolError(`Could not determine which deal this is (no terms or terms_hash). ${tail}`);

  const entry = pickFactory(cfg, factoryName, terms ? null : (claimedHash ?? null), claimedEscrow, tail);
  const checks: Check[] = [
    pass("factory_allowlisted", `escrow factory ${shortAddr(entry.address)} is allowlisted (${entry.status})`),
  ];
  if (input.vault_impl !== undefined && !isAddressEqual(input.vault_impl as Address, entry.vaultImpl)) {
    checks.push(
      fail(
        "vault_impl",
        `vault_impl ${shortAddr(input.vault_impl)} is not the factory's implementation ${shortAddr(entry.vaultImpl)}`,
      ),
    );
  }

  let derived: Derived | null = null;
  let termsHash: Hex;
  let escrow: Address;
  if (terms) {
    derived = derive(terms, entry.address, entry.vaultImpl);
    termsHash = derived.termsHash;
    escrow = derived.escrow;
    checks.push(...shapeChecks(terms));
    if (claimedHash !== undefined) {
      checks.push(
        claimedHash === termsHash
          ? pass("terms_hash", `deal hash recomputed from the terms: ${termsHash}`)
          : fail("terms_hash", `the claimed terms_hash ${claimedHash} is not the hash of these terms (${termsHash})`),
      );
    }
  } else {
    termsHash = claimedHash as Hex;
    escrow = escrowOf(termsHash, entry.address, entry.vaultImpl);
  }
  if (claimedEscrow !== undefined) {
    checks.push(
      isAddressEqual(claimedEscrow, escrow)
        ? pass("escrow_address", `escrow address recomputed locally (CREATE2): ${escrow}`)
        : fail(
            "escrow_address",
            `the claimed escrow ${claimedEscrow} is NOT the address derived from the deal (${escrow})`,
          ),
    );
  }

  const spec = await boundSpec(quote?.spec ?? order?.spec, terms);
  const safeOrder = order ? (capRecord(order) as Record<string, unknown> | null) : null;
  return { source, terms, factory: entry, termsHash, escrow, derived, quote, spec, order: safeOrder, paid, checks };
}
