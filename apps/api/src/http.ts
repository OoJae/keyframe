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

export async function readJson(
  req: Request,
  maxBytes = 64 * 1024,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: error(415, { error: "unsupported_media_type", detail: "send application/json" }) };
  }
  const text = await req.text();
  if (text.length > maxBytes) return { ok: false, response: error(413, { error: "body_too_large" }) };
  try {
    return { ok: true, value: JSON.parse(text) };
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
