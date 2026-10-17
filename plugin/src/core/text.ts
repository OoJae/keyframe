// Formatting for user-facing text and caps for untrusted (backend-sourced) data. Backend strings are data, never
// instructions: they are stripped of control/bidi characters, length-capped, and quoted where they appear in text.

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Single-line, control-free, length-capped copy of an untrusted string. */
export function clean(value: unknown, max = 200): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  const flat = s.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** An untrusted value as a quoted, escaped JSON string literal (an embedded quote cannot close it). */
export const quoted = (value: unknown, max = 64): string => JSON.stringify(clean(value, max));

/** A full address in groups of four for side-by-side comparison: "0x4B22 f48f B87B … b048". */
export function chunkAddr(a: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  return `${a.slice(0, 6)} ${(a.slice(6).match(/.{4}/g) ?? []).join(" ")}`;
}

/** UTF-8 size of a string (what reaches stdout). */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

export type JsonCaps = { maxString: number; maxArray: number; maxKeys: number; maxDepth: number };
export const DEFAULT_CAPS: JsonCaps = { maxString: 500, maxArray: 50, maxKeys: 60, maxDepth: 6 };

/**
 * Deep copy of untrusted JSON with every string/array/object capped. Non-JSON values are dropped, numbers must be
 * safe integers (so "1e20" cannot expand to 21 digits on output), and keys are sanitized too. Deterministic: key
 * order is preserved as received.
 */
export function capJson(value: unknown, caps: JsonCaps = DEFAULT_CAPS, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string") return clean(value, caps.maxString);
  if (depth >= caps.maxDepth) return null;
  if (Array.isArray(value)) return value.slice(0, caps.maxArray).map((v) => capJson(v, caps, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= caps.maxKeys) break;
      if (v === undefined || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") continue;
      const key = clean(k, 64);
      if (key === "" || key === "__proto__") continue;
      out[key] = capJson(v, caps, depth + 1);
      n++;
    }
    return out;
  }
  return null;
}

/** Default serialized-size cap for one echoed backend record (an order, a catalog entry). */
export const MAX_RECORD_BYTES = 32 * 1024;

/** capJson, then null if the capped record still serializes to more than `maxBytes`. */
export function capRecord(value: unknown, caps: JsonCaps = DEFAULT_CAPS, maxBytes = MAX_RECORD_BYTES): unknown {
  const out = capJson(value, caps);
  return utf8Bytes(JSON.stringify(out) ?? "null") <= maxBytes ? out : null;
}

/** Keeps records (in order) while each is at most `perRecord` and all together at most `total` bytes. */
export function capRecords<T>(records: readonly T[], perRecord: number, total: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const r of records) {
    const n = utf8Bytes(JSON.stringify(r) ?? "null");
    if (n > perRecord) continue;
    if (used + n > total) break;
    used += n;
    out.push(r);
  }
  return out;
}

/** Atomic USDC (6 decimals) as a fixed-point string with at least 2 decimals: 4000000 -> "4.00". */
export function usdc(atomic: bigint | string): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${sign}${whole}.${frac}`;
}

/** Wei as ETH with up to 6 decimals, rounded down. */
export function eth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) / 10n ** 12n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const shortAddr = (a: string): string => (a.length === 42 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const shortHash = (h: string): string => (h.length === 66 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h);

/** Unix seconds as "2026-10-18 14:32 UTC". */
export function utc(unix: number): string {
  if (!Number.isSafeInteger(unix) || unix < 0 || unix > 253_402_300_799) return "an invalid time";
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Unix seconds as ISO-8601 with whole seconds. */
export function isoSeconds(unix: number): string {
  if (!Number.isSafeInteger(unix) || unix < 0 || unix > 253_402_300_799) return "1970-01-01T00:00:00Z";
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Human duration: 30 -> "~30 s", 60 -> "~1 min", 7200 -> "~2 h", 259200 -> "~3 days". */
export function approxDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown time";
  if (seconds < 45) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `~${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 172_800) return `~${Math.round(seconds / 3600)} h`;
  return `~${Math.round(seconds / 86_400)} days`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
