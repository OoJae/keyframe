// Runtime configuration (frozen-interfaces.md §9). Env var names are frozen; values are editable in the portal after
// the upload lock. Read lazily inside tool handlers only, never at module load (discovery stays side-effect free).
// Embedded defaults keep the bundle runnable offline; allowlists default to EMPTY, so money tools fail closed until the
// portal variables name the deployed factory, seller and operators.
// Problems are reported by variable NAME only: values never appear in tool output.

import { type Address, getAddress, isAddress } from "viem";
import { MAX_AMOUNT, vaultImplOf } from "../protocol/index.js";

export const DEFAULTS = {
  KEYFRAME_API_BASE: "https://api.keyframe.studio",
  KEYFRAME_FILES_BASE: "https://files.keyframe.studio",
  KEYFRAME_RPC_URLS: "https://mainnet.base.org,https://base-rpc.publicnode.com",
  KEYFRAME_IPFS_GATEWAY: "https://ipfs.filebase.io",
  KEYFRAME_FACTORIES: "[]",
  KEYFRAME_SELLERS: "",
  KEYFRAME_OPERATORS: "",
  KEYFRAME_MAX_AMOUNT: MAX_AMOUNT.toString(),
  KEYFRAME_PRIMARY_RAIL: "x402",
  KEYFRAME_7702_POLICY: "direct-first",
  KEYFRAME_MAINTENANCE: "0",
} as const;

export type EnvName = keyof typeof DEFAULTS;
export type FactoryStatus = "active" | "refund-only";
export type FactoryEntry = { address: Address; vaultImpl: Address; status: FactoryStatus };
export type PrimaryRail = "x402" | "direct";
export type Policy7702 = "x402-autoundelegate" | "direct-first";

export type Config = {
  apiBase: string;
  filesBase: string;
  ipfsGateway: string | null;
  rpcUrls: string[];
  factories: FactoryEntry[];
  sellers: Address[];
  operators: Address[];
  maxAmount: bigint;
  primaryRail: PrimaryRail;
  policy7702: Policy7702;
  maintenance: boolean;
  /** Invalid variables (names only). A listed variable falls back to its fail-closed default. */
  problems: EnvName[];
};

const MAX_FACTORIES = 8;
const MAX_LIST = 16;
const MAX_RPCS = 3;
const MAX_ENV_CHARS = 4096;

class EnvProblem extends Error {}

type Env = Record<string, string | undefined>;

function raw(env: Env, name: EnvName): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") return DEFAULTS[name];
  if (v.length > MAX_ENV_CHARS) throw new EnvProblem();
  return v.trim();
}

/** https origin on port 443 without credentials, query or fragment; `allowPath` keeps a path prefix. */
export function httpsBase(value: string, allowPath: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvProblem();
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || url.username || url.password) {
    throw new EnvProblem();
  }
  if (url.search || url.hash) throw new EnvProblem();
  const path = url.pathname.replace(/\/+$/, "");
  if (!allowPath && path !== "") throw new EnvProblem();
  return `https://${url.hostname}${path}`;
}

function addressList(value: string): Address[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (items.length > MAX_LIST) throw new EnvProblem();
  return items.map(strictAddress);
}

/** Lower/upper-case or correctly checksummed (a mixed-case typo is rejected, as EIP-55 intends). */
export function strictAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new EnvProblem();
  const body = value.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && getAddress(value) !== value) throw new EnvProblem();
  return getAddress(value);
}

function factories(value: string): FactoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EnvProblem();
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_FACTORIES) throw new EnvProblem();
  return parsed.map((entry): FactoryEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new EnvProblem();
    const e = entry as Record<string, unknown>;
    if (typeof e.address !== "string" || typeof e.vaultImpl !== "string") throw new EnvProblem();
    if (e.status !== "active" && e.status !== "refund-only") throw new EnvProblem();
    const address = strictAddress(e.address);
    const vaultImpl = strictAddress(e.vaultImpl);
    // §2: VAULT_IMPL is the factory's first CREATE (nonce 1). Anything else is a misconfiguration.
    if (vaultImpl !== vaultImplOf(address)) throw new EnvProblem();
    return { address, vaultImpl, status: e.status };
  });
}

function rpcList(value: string): string[] {
  const urls = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (urls.length === 0) throw new EnvProblem();
  return [...new Set(urls.map((u) => httpsBase(u, true)))].slice(0, MAX_RPCS);
}

function maxAmount(value: string): bigint {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new EnvProblem();
  const v = BigInt(value);
  // §8: amount <= KEYFRAME_MAX_AMOUNT <= 50 USDC. A larger setting is clamped to the hard cap.
  return v > MAX_AMOUNT ? MAX_AMOUNT : v;
}

function oneOf<T extends string>(value: string, options: readonly T[]): T {
  if (!(options as readonly string[]).includes(value)) throw new EnvProblem();
  return value as T;
}

export function loadConfig(env: Env = process.env): Config {
  const problems: EnvName[] = [];
  function read<T>(name: EnvName, parse: (v: string) => T, fallback: () => T): T {
    try {
      return parse(raw(env, name));
    } catch (error) {
      if (!(error instanceof EnvProblem)) throw error;
      problems.push(name);
      return fallback();
    }
  }
  const factoriesValue = read("KEYFRAME_FACTORIES", factories, () => []);
  return {
    apiBase: read(
      "KEYFRAME_API_BASE",
      (v) => httpsBase(v, false),
      () => DEFAULTS.KEYFRAME_API_BASE,
    ),
    filesBase: read(
      "KEYFRAME_FILES_BASE",
      (v) => httpsBase(v, true),
      () => DEFAULTS.KEYFRAME_FILES_BASE,
    ),
    ipfsGateway: read(
      "KEYFRAME_IPFS_GATEWAY",
      (v) => (v === "off" ? null : httpsBase(v, true)),
      () => null,
    ),
    rpcUrls: read("KEYFRAME_RPC_URLS", rpcList, () => rpcList(DEFAULTS.KEYFRAME_RPC_URLS)),
    factories: factoriesValue,
    sellers: read("KEYFRAME_SELLERS", addressList, () => []),
    operators: read("KEYFRAME_OPERATORS", addressList, () => []),
    maxAmount: read("KEYFRAME_MAX_AMOUNT", maxAmount, () => 0n),
    primaryRail: read(
      "KEYFRAME_PRIMARY_RAIL",
      (v) => oneOf(v, ["x402", "direct"] as const),
      () => "x402",
    ),
    policy7702: read(
      "KEYFRAME_7702_POLICY",
      (v) => oneOf(v, ["x402-autoundelegate", "direct-first"] as const),
      () => "direct-first",
    ),
    // Fails safe: an unreadable switch means paused.
    maintenance: read(
      "KEYFRAME_MAINTENANCE",
      (v) => oneOf(v, ["0", "1"] as const) === "1",
      () => true,
    ),
    problems,
  };
}

export function findFactory(cfg: Config, address: string): FactoryEntry | undefined {
  const a = address.toLowerCase();
  return cfg.factories.find((f) => f.address.toLowerCase() === a);
}

export const inList = (list: readonly Address[], a: string): boolean =>
  list.some((x) => x.toLowerCase() === a.toLowerCase());
