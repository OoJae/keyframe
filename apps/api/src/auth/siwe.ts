import { CHAIN_ID } from "@keyframe/protocol";
import { type Address, getAddress, type Hex, isAddress, recoverMessageAddress } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import * as z from "zod/v4";
import { error, json } from "../http.js";
import { ownerOrders } from "../orders/status.js";
import { nowS, type Services } from "../services.js";

// New-chat recovery (frozen §7): POST /v1/auth/siwe/challenge {address} → {message};
// POST /v1/auth/siwe/verify {address, message, signature} → {orders:[…with access_token, k_buyer]}.
// EIP-4361 message bound to our domain, chain 8453 and a single-use server nonce (10 min).

const CHALLENGE_TTL_S = 600;

/** 32 hex chars from the CSPRNG (viem's generateSiweNonce is Math.random-based and 96 chars, which the plugin's
 *  strict EIP-4361 check, [A-Za-z0-9]{8,64}, would refuse). */
const siweNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const STATEMENT = "Sign in to Keyframe to list your orders and recover delivery keys. This does not move funds.";

const ChallengeBody = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const VerifyBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){65,2048}$/),
});

export async function siweChallenge(s: Services, body: unknown): Promise<Response> {
  const p = ChallengeBody.safeParse(body);
  if (!p.success || !isAddress(p.data.address, { strict: false })) return error(400, { error: "address_required" });
  const address = getAddress(p.data.address);
  const now = nowS(s);
  const nonce = siweNonce();
  const message = createSiweMessage({
    address,
    chainId: CHAIN_ID,
    domain: new URL(s.cfg.publicBaseUrl).host,
    uri: s.cfg.publicBaseUrl,
    version: "1",
    nonce,
    statement: STATEMENT,
    issuedAt: new Date(now * 1000),
    expirationTime: new Date((now + CHALLENGE_TTL_S) * 1000),
  });
  await s.repo.insertSiweNonce(nonce, address.toLowerCase(), message, now + CHALLENGE_TTL_S);
  return json(200, { message, nonce, expires_at: now + CHALLENGE_TTL_S });
}

/** EOA signatures are checked offline; anything else (ERC-1271 / 6492 smart wallets) via the RPC. */
async function signedBy(s: Services, address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    if ((await recoverMessageAddress({ message, signature })) === address) return true;
  } catch {
    // not a plain 65-byte ECDSA signature
  }
  if (!s.chain) return false;
  try {
    return await s.chain.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

export async function siweVerify(s: Services, body: unknown): Promise<Response> {
  const p = VerifyBody.safeParse(body);
  if (!p.success) return error(400, { error: "invalid_request" });
  const address = getAddress(p.data.address);
  const now = nowS(s);
  const fields = parseSiweMessage(p.data.message);
  const valid =
    fields.nonce !== undefined &&
    fields.chainId === CHAIN_ID &&
    fields.uri === s.cfg.publicBaseUrl &&
    validateSiweMessage({
      message: fields,
      address,
      domain: new URL(s.cfg.publicBaseUrl).host,
      time: new Date(now * 1000),
    });
  if (!valid || !fields.nonce) return error(401, { error: "invalid_message" });
  if (!(await signedBy(s, address, p.data.message, p.data.signature as Hex))) {
    return error(401, { error: "invalid_signature" });
  }
  if (!(await s.repo.consumeSiweNonce(fields.nonce, address.toLowerCase(), p.data.message, now))) {
    return error(401, { error: "nonce_expired_or_used" });
  }
  return json(200, { v: 1, address, orders: await ownerOrders(s, address.toLowerCase()) });
}
