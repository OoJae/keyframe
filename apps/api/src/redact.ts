// Error text that may be logged or stored (orders.last_error, payments.error). RPC providers put API keys in the
// URL path or query, and viem echoes the URL ("URL: https://…/v2/<key>") and the request body in its messages, so
// every URL is reduced to its host, request bodies / call arguments are dropped, long hex blobs (calldata, which can
// carry K_chain) are cut, and long mixed letter+digit tokens (API keys) are masked. Tx hashes (0x + 64 hex) and
// snake_case reasons stay readable.

const URL_RE = /\b(?:https?|wss?):\/\/([^\s/"'?#]+)[^\s"']*/gi;
const TRAILER = /\b(?:Request body|Details|Raw Call Arguments|Contract Call):[\s\S]*$/i;
const LONG_HEX = /0x[0-9a-fA-F]{65,}/g;
const TOKEN = /[A-Za-z0-9_-]{24,}/g;

function maskToken(t: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t;
  const digits = (t.match(/[0-9]/g) ?? []).length;
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  return digits >= 2 && letters >= 2 ? "<redacted>" : t;
}

export function redact(text: string, max = 200): string {
  return text
    .replace(URL_RE, (_m, host: string) => `<url:${host.split("@").pop() ?? "?"}>`)
    .replace(TRAILER, "")
    .replace(LONG_HEX, (m) => `${m.slice(0, 10)}…`)
    .replace(TOKEN, maskToken)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Redacted, length-capped message of any thrown value (prefers viem's shortMessage). */
export function errorText(e: unknown, max = 200): string {
  if (e && typeof e === "object") {
    const short = (e as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return redact(short, max);
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string") return redact(msg, max);
  }
  return redact(String(e), max);
}
