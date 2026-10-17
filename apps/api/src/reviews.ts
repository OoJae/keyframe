import { CHAIN_ID, decisionTypedData, EIP712_NAME, EIP712_VERSION } from "@keyframe/protocol";
import { type Address, type Hex, recoverTypedDataAddress } from "viem";
import * as z from "zod/v4";
import { error, json } from "./http.js";
import { checkAccessToken } from "./orders/access.js";
import { advanceOrder, encodeFactoryCall, runAction } from "./orders/lifecycle.js";
import type { Background } from "./orders/paid.js";
import { termsOf } from "./quotes/view.js";
import { nowS, type Services } from "./services.js";

// Studio review (frozen §7): challenge → EIP-712 typed data for the buyer to sign with request_wallet_sign;
// submit → verify signer == T.buyer, then relay factory.decideBySig (accept / reject). "changes" (the one included
// revision) is off-chain: the buyer signs a ChangeRequest under the same domain, which the factory never accepts
// as a Decision, so that signature cannot move money; it only authenticates the request.

const SIG_TTL_S = 3600;
const Decision = z.enum(["accept", "reject", "changes"]);
const ChallengeBody = z.object({ access_token: z.string(), decision: Decision });
const SubmitBody = z.object({
  access_token: z.string(),
  decision: Decision,
  signature: z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2}){65,1024}$/)
    .optional(),
  sig_deadline: z.int().min(0).optional(),
});

const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export const CHANGE_REQUEST_TYPES = {
  ChangeRequest: [
    { name: "termsHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function changeRequestTypedData(termsHash: Hex, deadline: number, factory: Address) {
  return {
    domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId: CHAIN_ID, verifyingContract: factory },
    types: CHANGE_REQUEST_TYPES,
    primaryType: "ChangeRequest" as const,
    message: { termsHash, deadline: BigInt(deadline) },
  };
}

type SignedTypedData = ReturnType<typeof decisionTypedData> | ReturnType<typeof changeRequestTypedData>;

/** JSON form for eth_signTypedData_v4 (uint256 as a decimal string). */
function typedDataJson(td: SignedTypedData) {
  const [name, fields] = Object.entries(td.types)[0] as [string, readonly { name: string; type: string }[]];
  return {
    domain: td.domain,
    types: { EIP712Domain: DOMAIN_TYPE, [name]: fields },
    primaryType: td.primaryType,
    message: { ...td.message, deadline: td.message.deadline.toString() },
  };
}

export const decisionJson = (termsHash: Hex, accept: boolean, deadline: number, factory: Address) =>
  typedDataJson(decisionTypedData(termsHash, accept, deadline, factory));

async function load(s: Services, orderId: string, token: string) {
  const o = await s.repo.getOrder(orderId);
  if (!o) return error(404, { error: "unknown_order" });
  const secret = s.cfg.secrets.accessSecret;
  if (!secret || !(await checkAccessToken(secret, o.id, token))) return error(401, { error: "invalid_token" });
  if (o.tier !== "studio") return error(409, { error: "not_a_studio_order" });
  const q = await s.repo.getQuote(o.quote_id);
  if (!q) return error(500, { error: "order_without_quote" });
  if (o.status !== "delivered") return error(409, { error: "not_in_review", status: o.status });
  const t = termsOf(q);
  const now = nowS(s);
  const endsAt = (o.delivered_at ?? 0) + t.reviewWindow;
  if (now >= endsAt) return error(409, { error: "review_closed", review_ends_at: endsAt });
  return { o, q, t, now, endsAt };
}

function typedFor(decision: z.infer<typeof Decision>, termsHash: Hex, deadline: number, factory: Address) {
  return decision === "changes"
    ? changeRequestTypedData(termsHash, deadline, factory)
    : decisionTypedData(termsHash, decision === "accept", deadline, factory);
}

export async function reviewChallenge(s: Services, orderId: string, body: unknown): Promise<Response> {
  const b = ChallengeBody.safeParse(body);
  if (!b.success) return error(400, { error: "invalid_request" });
  const ctx = await load(s, orderId, b.data.access_token);
  if (ctx instanceof Response) return ctx;
  const { o, q, now, endsAt } = ctx;
  if (b.data.decision === "changes" && o.change_requested_at !== null) {
    return error(409, { error: "revision_already_requested" });
  }
  const sigDeadline = Math.min(now + SIG_TTL_S, endsAt);
  return json(200, {
    order_id: o.id,
    decision: b.data.decision,
    typed_data: typedDataJson(typedFor(b.data.decision, o.terms_hash as Hex, sigDeadline, s.cfg.factory)),
    sig_deadline: sigDeadline,
    review_ends_at: endsAt,
    preview_url: q.preview_url,
    note:
      b.data.decision === "changes"
        ? "Signing this asks for the one included revision; it is not a Decision and cannot move money."
        : "Sign typed_data with request_wallet_sign (EIP-712, no gas), then call submit with the signature.",
  });
}

async function signedByBuyer(s: Services, buyer: Address, td: SignedTypedData, signature: Hex) {
  try {
    const signer = await recoverTypedDataAddress({ ...td, signature } as Parameters<typeof recoverTypedDataAddress>[0]);
    if (signer === buyer) return true;
  } catch {
    // not a plain ECDSA signature
  }
  if (!s.chain) return false;
  try {
    const args = { address: buyer, ...td, signature } as Parameters<
      NonNullable<Services["chain"]>["verifyTypedData"]
    >[0];
    return await s.chain.verifyTypedData(args);
  } catch {
    return false;
  }
}

export async function reviewSubmit(s: Services, orderId: string, body: unknown, background: Background) {
  const b = SubmitBody.safeParse(body);
  if (!b.success) return error(400, { error: "invalid_request" });
  const ctx = await load(s, orderId, b.data.access_token);
  if (ctx instanceof Response) return ctx;
  const { o, t, now } = ctx;
  const { signature, sig_deadline: sigDeadline, decision } = b.data;
  if (!signature || sigDeadline === undefined) return error(400, { error: "signature_and_sig_deadline_required" });
  if (sigDeadline <= now || sigDeadline > now + 2 * SIG_TTL_S) return error(400, { error: "bad_sig_deadline" });
  if (decision === "changes" && o.change_requested_at !== null) {
    return error(409, { error: "revision_already_requested" });
  }
  const td = typedFor(decision, o.terms_hash as Hex, sigDeadline, s.cfg.factory);
  if (!(await signedByBuyer(s, t.buyer, td, signature as Hex))) return error(401, { error: "invalid_signature" });

  if (decision === "changes") {
    await s.repo.updateOrder(o.id, { change_requested_at: now }, now);
    s.log.info("studio_changes_requested", { order_id: o.id });
    return json(200, { order_id: o.id, decision, tx: null, state: "changes_requested", status: "changes_requested" });
  }
  const accept = decision === "accept";
  const data = encodeFactoryCall.decideBySig(t, accept, BigInt(sigDeadline), signature as Hex);
  const r = await runAction(s, o, "decide", data, 8_000);
  if (r.state === "busy") return error(409, { error: "order_busy", detail: "retry shortly" });
  if (r.state !== "confirmed" && r.state !== "pending") return error(502, { error: "relay_failed", detail: r.reason });
  if (accept && r.state === "confirmed") {
    const next = await s.repo.getOrder(o.id);
    if (next) background(advanceOrder(s, next, 8_000).catch(() => undefined));
  }
  return json(200, { order_id: o.id, decision, tx: r.hash, state: r.state, status: r.state });
}
