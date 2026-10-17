// Small response helpers. Every JSON response is `no-store`: quotes and orders change state.

export interface ApiError {
  error: string;
  detail?: string;
  [extra: string]: unknown;
}

export const NO_STORE = "no-store";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE, ...headers },
  });
}

/** `message` mirrors `detail`: the plugin shows the backend's `message` (else `error`) to the agent. */
export const error = (status: number, e: ApiError, headers?: Record<string, string>): Response =>
  json(status, e.detail && e.message === undefined ? { ...e, message: e.detail } : e, headers);

/** Errors on the paid path always say whether money moved. */
export const notCharged = (status: number, e: ApiError, headers?: Record<string, string>): Response =>
  error(status, { ...e, charged: false }, headers);

/**
 * The authorization is being (or may have been) settled and the outcome is not known yet: never "charged: false".
 * The client must retry the same request (same payment header) or poll; it must not sign a new payment.
 */
export const chargeUnknown = (status: number, e: ApiError, headers?: Record<string, string>): Response =>
  error(status, { ...e, charged: "unknown" }, headers);

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; response: Response };

/**
 * Reads at most `max` bytes: a declared Content-Length above the cap is refused before any byte is read, and an
 * undeclared (chunked) body is streamed and cut off as soon as it passes the cap.
 */
export async function readBody(req: Request, max: number): Promise<BodyRead> {
  const tooLarge = (): BodyRead => ({ ok: false, response: error(413, { error: "body_too_large", max }) });
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared) > max)) return tooLarge();
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  return { ok: true, bytes };
}

export async function readJson(
  req: Request,
  maxBytes = 64 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: error(415, { error: "unsupported_media_type", detail: "send application/json" }) };
  }
  const body = await readBody(req, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body.bytes)) };
  } catch {
    return { ok: false, response: error(400, { error: "invalid_json" }) };
  }
}

/** Constant-time string comparison (both sides hashed first so lengths do not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= (xa[i] ?? 0) ^ (ya[i] ?? 0);
  return diff === 0;
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
