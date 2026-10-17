import { base64url, safeEqual } from "../http.js";

// access_token = b64url(HMAC-SHA256(ACCESS_SECRET, "kf/access/v1/" ‖ order_id)): 43 chars, stateless, rotatable
// by changing ACCESS_SECRET (which invalidates every outstanding token).

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret.slice(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function accessToken(secret: Uint8Array, orderId: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`kf/access/v1/${orderId}`),
  );
  return base64url(new Uint8Array(sig));
}

export async function checkAccessToken(secret: Uint8Array, orderId: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return safeEqual(await accessToken(secret, orderId), token);
}
