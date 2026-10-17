// Worker bindings and parsed configuration for the Keyframe interop spike.
// Secrets (SPIKE_MNEMONIC, SPIKE_ADMIN_TOKEN) are only ever read here and never echoed.

export interface Env {
  SPIKE_KV: KVNamespace;
  // vars (wrangler.toml [vars]; editable without code changes)
  PUBLIC_BASE_URL?: string;
  X402_MODE?: string;
  PAID_DELAY_MS?: string;
  SETTLE_MODE?: string;
  FACILITATOR_URL?: string;
  MAX_AMOUNT_ATOMIC?: string;
  PAID_BODY_PAD_BYTES?: string;
  // secrets (wrangler secret put ...)
  SPIKE_MNEMONIC?: string;
  SPIKE_ADMIN_TOKEN?: string;
}

export type WireMode = "v2" | "v1";
export type SettleMode = "wait" | "broadcast";

export interface Config {
  publicBaseUrl: string | null;
  mode: WireMode;
  paidDelayMs: number;
  settleMode: SettleMode;
  facilitatorUrl: string;
  maxAmountAtomic: bigint;
  paidBodyPadBytes: number;
}

export const MIN_AMOUNT_ATOMIC = 100_000n; // 0.10 USDC
export const HARD_MAX_AMOUNT_ATOMIC = 50_000_000n; // 50 USDC (plan cap)
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const NETWORK_V2 = "eip155:8453" as const;
export const NETWORK_V1 = "base" as const;
export const MAX_TIMEOUT_SECONDS = 300;
export const USDC_EXTRA = { name: "USD Coin", version: "2" } as const;

function intInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d{1,9}$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Math.min(max, Math.max(min, n));
}

export function canonicalBase(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return `${url.protocol}//${url.host}`;
}

export function readConfig(env: Env): Config {
  const mode: WireMode = (env.X402_MODE ?? "v2").trim().toLowerCase() === "v1" ? "v1" : "v2";
  const settleMode: SettleMode = (env.SETTLE_MODE ?? "wait").trim().toLowerCase() === "broadcast" ? "broadcast" : "wait";
  let maxAmount = HARD_MAX_AMOUNT_ATOMIC;
  if (env.MAX_AMOUNT_ATOMIC && /^[1-9][0-9]{0,9}$/.test(env.MAX_AMOUNT_ATOMIC.trim())) {
    const parsed = BigInt(env.MAX_AMOUNT_ATOMIC.trim());
    if (parsed >= MIN_AMOUNT_ATOMIC && parsed <= HARD_MAX_AMOUNT_ATOMIC) maxAmount = parsed;
  }
  return {
    publicBaseUrl: canonicalBase(env.PUBLIC_BASE_URL),
    mode,
    paidDelayMs: intInRange(env.PAID_DELAY_MS, 0, 0, 60_000),
    settleMode,
    facilitatorUrl: canonicalBase(env.FACILITATOR_URL) ?? "https://facilitator.payai.network",
    maxAmountAtomic: maxAmount,
    paidBodyPadBytes: intInRange(env.PAID_BODY_PAD_BYTES, 0, 0, 16_384),
  };
}
