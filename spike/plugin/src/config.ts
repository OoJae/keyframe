// Runtime configuration for the Keyframe spike plugin. Read lazily (never at module load) so the bundle
// stays side-effect free during PayBox discovery and works offline under local conformance.

export const DEFAULT_API_BASE = "https://keyframe-spike.example.workers.dev";
export const BASE_CHAIN = "eip155:8453" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const MIN_AMOUNT = 100_000n; // 0.10 USDC
export const HARD_MAX_AMOUNT = 50_000_000n; // 50 USDC
export const QUOTE_ID = /^q_[1-9A-HJ-NP-Za-km-z]{22}$/;
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;

export type ApiBase = { base: string; source: "env" | "default" };

/** KEYFRAME_API_BASE must be a bare https origin (port 443, no path, query or credentials). */
export function resolveApiBase(): ApiBase {
  const raw = process.env.KEYFRAME_API_BASE?.trim();
  if (!raw) return { base: DEFAULT_API_BASE, source: "default" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("KEYFRAME_API_BASE is not a valid URL; set it to the spike Worker origin, e.g. https://keyframe-spike.<account>.workers.dev");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("KEYFRAME_API_BASE must be a bare https origin on port 443 (no path, query or credentials)");
  }
  return { base: `https://${url.hostname}`, source: "env" };
}

export function apiBaseSource(): "env" | "default" | "env_invalid" {
  try {
    return resolveApiBase().source;
  } catch {
    return "env_invalid";
  }
}

/** Atomic USDC (6 decimals) to a fixed-point string, without floating point. */
export function usdc(atomic: string): string {
  const v = BigInt(atomic);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}`;
}
