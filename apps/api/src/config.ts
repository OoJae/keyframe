import { CHAIN_ID, MAX_AMOUNT, USDC, vaultImplOf } from "@keyframe/protocol";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Typed configuration parsed once per isolate from Worker vars + secrets. Secrets are held as values here and
// never logged; `publicConfig()` is the only view that leaves the process (/health).

/** String vars and secrets as Wrangler provides them (all optional at the type level; validated here). */
export interface RawEnv {
  PUBLIC_BASE_URL?: string;
  FILES_BASE_URL?: string;
  FACTORY_ADDRESS?: string;
  VAULT_IMPL_ADDRESS?: string;
  SELLER_ADDRESS?: string;
  OPERATOR_ADDRESS?: string;
  USDC_ADDRESS?: string;
  RPC_URL?: string;
  X402_WIRE?: string;
  FACILITATOR_FALLBACK_URL?: string;
  MAX_AMOUNT?: string;
  QUOTE_TTL_S?: string;
  DRAFT_TTL_S?: string;
  MIN_RELEASE_MARGIN_S?: string;
  STUDIO_REVIEW_S?: string;
  STUDIO_KILL_FEE_BPS?: string;
  STUDIO_MAX_OPEN?: string;
  MAX_INFLIGHT_ORDERS?: string;
  RECEIPT_WAIT_MS?: string;
  OFAC_LIST_URL?: string;
  OFAC_MAX_AGE_S?: string;
  OFAC_REFRESH_S?: string;
  FORMATS_DISABLED?: string;
  POLICY_DENYLIST?: string;
  QUOTES_PER_BUYER_PER_HOUR?: string;
  MAINTENANCE?: string;
  KMASTER?: string;
  RELAYER_PRIVATE_KEY?: string;
  WORKER_TOKEN?: string;
  ACCESS_SECRET?: string;
}

export type X402Wire = "v1" | "v2";

export interface Config {
  publicBaseUrl: string;
  filesBaseUrl: string;
  factory: Address;
  vaultImpl: Address;
  seller: Address;
  operator: Address | null;
  usdc: Address;
  rpcUrl: string | null;
  wire: X402Wire;
  facilitatorFallbackUrl: string | null;
  maxAmount: bigint;
  quoteTtlS: number;
  draftTtlS: number;
  minReleaseMarginS: number;
  studioReviewS: number;
  studioKillFeeBps: number;
  studioMaxOpen: number;
  maxInflightOrders: number;
  receiptWaitMs: number;
  ofacListUrl: string;
  ofacMaxAgeS: number;
  ofacRefreshS: number;
  formatsDisabled: ReadonlySet<string>;
  policyDenylist: readonly string[];
  quotesPerBuyerPerHour: number;
  maintenance: boolean;
  secrets: Secrets;
  /** Human-readable problems that make money paths unavailable (quotes/settlement return 503). */
  problems: readonly string[];
}

export interface Secrets {
  kmaster: Uint8Array | null;
  relayerPrivateKey: Hex | null;
  workerToken: string | null;
  accessSecret: Uint8Array | null;
}

export const DEFAULT_OFAC_LIST_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json";
export const DEFAULT_FACILITATOR_FALLBACK_URL = "https://facilitator.payai.network";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const HEX32_PLUS = /^(0x)?([0-9a-fA-F]{2}){32,}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function baseUrl(raw: string | undefined, name: string, problems: string[], allowPath: boolean): string {
  try {
    if (!raw) throw new Error("missing");
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("must be https");
    if (u.search || u.hash) throw new Error("must not carry a query or fragment");
    if (!allowPath && u.pathname !== "/") throw new Error("must be an origin (no path)");
    return raw.replace(/\/+$/, "");
  } catch (e) {
    problems.push(`${name} ${(e as Error).message}`);
    return "http://localhost";
  }
}

function address(raw: string | undefined, name: string, problems: string[], fallback?: Address): Address {
  if (!raw) {
    if (fallback) return fallback;
    problems.push(`${name} missing`);
    return ZERO_ADDRESS;
  }
  if (!isAddress(raw, { strict: false })) {
    problems.push(`${name} invalid`);
    return ZERO_ADDRESS;
  }
  return getAddress(raw);
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

function hexBytes(raw: string | undefined): Uint8Array | null {
  if (!raw || !HEX32_PLUS.test(raw.trim())) return null;
  const h = raw.trim().replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

export function parseConfig(env: RawEnv): Config {
  const problems: string[] = [];
  const publicBaseUrl = baseUrl(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL", problems, false);
  const filesBaseUrl = env.FILES_BASE_URL
    ? baseUrl(env.FILES_BASE_URL, "FILES_BASE_URL", problems, true)
    : `${publicBaseUrl}/files`;
  const factory = address(env.FACTORY_ADDRESS, "FACTORY_ADDRESS", problems);
  const vaultImpl = address(env.VAULT_IMPL_ADDRESS, "VAULT_IMPL_ADDRESS", problems, vaultImplOf(factory));
  const seller = address(env.SELLER_ADDRESS, "SELLER_ADDRESS", problems);
  const usdc = address(env.USDC_ADDRESS, "USDC_ADDRESS", problems, USDC);

  const relayerPrivateKey =
    env.RELAYER_PRIVATE_KEY && PRIVATE_KEY.test(env.RELAYER_PRIVATE_KEY.trim())
      ? (env.RELAYER_PRIVATE_KEY.trim() as Hex)
      : null;
  if (!relayerPrivateKey) problems.push("RELAYER_PRIVATE_KEY missing or malformed");
  let operator: Address | null = null;
  if (relayerPrivateKey) {
    operator = privateKeyToAccount(relayerPrivateKey).address;
    if (env.OPERATOR_ADDRESS && getAddress(env.OPERATOR_ADDRESS) !== operator) {
      problems.push("OPERATOR_ADDRESS does not match RELAYER_PRIVATE_KEY");
    }
  }

  const kmaster = hexBytes(env.KMASTER);
  if (!kmaster) problems.push("KMASTER missing or shorter than 32 bytes (hex)");
  const accessSecret = hexBytes(env.ACCESS_SECRET);
  if (!accessSecret) problems.push("ACCESS_SECRET missing or shorter than 32 bytes (hex)");
  const workerToken = env.WORKER_TOKEN && env.WORKER_TOKEN.length >= 32 ? env.WORKER_TOKEN : null;
  if (!workerToken) problems.push("WORKER_TOKEN missing or shorter than 32 chars");

  let maxAmount = MAX_AMOUNT;
  if (env.MAX_AMOUNT && /^[1-9][0-9]{0,8}$/.test(env.MAX_AMOUNT)) {
    const m = BigInt(env.MAX_AMOUNT);
    maxAmount = m < MAX_AMOUNT ? m : MAX_AMOUNT;
  }
  const wire: X402Wire = env.X402_WIRE === "v1" ? "v1" : "v2";
  const fallback = env.FACILITATOR_FALLBACK_URL ?? DEFAULT_FACILITATOR_FALLBACK_URL;

  return {
    publicBaseUrl,
    filesBaseUrl,
    factory,
    vaultImpl,
    seller,
    operator,
    usdc,
    rpcUrl: env.RPC_URL && /^https?:\/\//.test(env.RPC_URL) ? env.RPC_URL : null,
    wire,
    facilitatorFallbackUrl: fallback.trim() === "" ? null : fallback.trim(),
    maxAmount,
    quoteTtlS: int(env.QUOTE_TTL_S, 600, 120, 3600),
    draftTtlS: int(env.DRAFT_TTL_S, 900, 60, 7200),
    minReleaseMarginS: int(env.MIN_RELEASE_MARGIN_S, 300, 60, 3600),
    studioReviewS: int(env.STUDIO_REVIEW_S, 86_400, 3600, 7 * 86_400),
    studioKillFeeBps: int(env.STUDIO_KILL_FEE_BPS, 0, 0, 10_000),
    studioMaxOpen: int(env.STUDIO_MAX_OPEN, 3, 0, 100),
    maxInflightOrders: int(env.MAX_INFLIGHT_ORDERS, 20, 1, 1000),
    receiptWaitMs: int(env.RECEIPT_WAIT_MS, 1200, 0, 10_000),
    ofacListUrl: env.OFAC_LIST_URL || DEFAULT_OFAC_LIST_URL,
    ofacMaxAgeS: int(env.OFAC_MAX_AGE_S, 7 * 86_400, 3600, 30 * 86_400),
    ofacRefreshS: int(env.OFAC_REFRESH_S, 6 * 3600, 300, 7 * 86_400),
    formatsDisabled: new Set(list(env.FORMATS_DISABLED ?? "chart_moment")),
    policyDenylist: list(env.POLICY_DENYLIST),
    quotesPerBuyerPerHour: int(env.QUOTES_PER_BUYER_PER_HOUR, 30, 1, 10_000),
    maintenance: env.MAINTENANCE === "1",
    secrets: { kmaster, relayerPrivateKey, workerToken, accessSecret },
    problems,
  };
}

/** Non-secret configuration for /health and discovery documents. */
export function publicConfig(c: Config) {
  return {
    chain_id: CHAIN_ID,
    public_base_url: c.publicBaseUrl,
    files_base_url: c.filesBaseUrl,
    factory: c.factory,
    vault_impl: c.vaultImpl,
    seller: c.seller,
    operator: c.operator,
    usdc: c.usdc,
    x402_wire: c.wire,
    facilitator_fallback: c.facilitatorFallbackUrl !== null,
    max_amount: c.maxAmount.toString(),
    maintenance: c.maintenance,
    configured: c.problems.length === 0,
    problems: c.problems.length,
  };
}
