import { CHAIN_ID, decisionTypedData, EIP712_NAME, EIP712_VERSION } from "@keyframe/protocol";
import { type Address, type Hex, recoverTypedDataAddress } from "viem";
import * as z from "zod/v4";
import { error, json } from "./http.js";
import { checkAccessToken } from "./orders/access.js";
import { advanceOrder, CHANGES_POLICY, encodeFactoryCall, runAction, studioWindows } from "./orders/lifecycle.js";
import type { Background } from "./orders/paid.js";
import { termsOf } from "./quotes/view.js";
import { errorText } from "./redact.js";
import { nowS, type Services } from "./services.js";

// Studio review (frozen §7): challenge → EIP-712 typed data for the buyer to sign with request_wallet_sign;
// submit → verify signer == T.buyer, then relay factory.decideBySig (accept / reject). "changes" (the one included
// revision) is off-chain: the buyer signs a ChangeRequest(bytes32 termsHash,uint256 deadline) under the same
// domain, which the factory never accepts as a Decision, so that signature cannot move money; it only
// authenticates the request.
//
// After a change request Keyframe never releases on silence (lifecycle.ts CHANGES_POLICY): the studio may deliver
// one revision, and only the buyer's explicit accept releases. Inside the on-chain review window decisions are
// relayed with decideBySig; after it (until accept_by) an accept is verified off-chain and the operator releases,
// a reject is answered with cancel (everything back to the buyer, no kill fee).

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

type ReviewPhase = "review" | "after_changes";

async function load(s: Services, orderId: string, token: string, decision: z.infer<typeof Decision>) {
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
  const { reviewEnd, acceptBy } = studioWindows(o, t);
  const changes = o.change_requested_at !== null && o.change_requested_at !== undefined;
  let phase: ReviewPhase = "review";
  if (now >= reviewEnd) {
    // The on-chain review window is over. Only an order with a change request is still waiting on the buyer.
    if (!changes || decision === "changes" || now >= acceptBy || o.accepted === 1 || o.buyer_accepted_at) {
      return error(409, {
        error: "review_closed",
        review_ends_at: reviewEnd,
        ...(changes ? { accept_by: acceptBy } : {}),
      });
    }
    phase = "after_changes";
  }
  return { o, q, t, now, endsAt: phase === "review" ? reviewEnd : acceptBy, reviewEnd, acceptBy, changes, phase };
}

function typedFor(decision: z.infer<typeof Decision>, termsHash: Hex, deadline: number, factory: Address) {
  return decision === "changes"
    ? changeRequestTypedData(termsHash, deadline, factory)
    : decisionTypedData(termsHash, decision === "accept", deadline, factory);
}

const changesInfo = (ctx: { changes: boolean; acceptBy: number }, o: { revision_delivered_at?: number | null }) =>
  ctx.changes
    ? {
        accept_by: ctx.acceptBy,
        revision_delivered: (o.revision_delivered_at ?? null) !== null,
        policy: CHANGES_POLICY,
      }
    : {};

export async function reviewChallenge(s: Services, orderId: string, body: unknown): Promise<Response> {
  const b = ChallengeBody.safeParse(body);
  if (!b.success) return error(400, { error: "invalid_request" });
  const ctx = await load(s, orderId, b.data.access_token, b.data.decision);
  if (ctx instanceof Response) return ctx;
  const { o, q, now, endsAt, reviewEnd } = ctx;
  if (b.data.decision === "changes" && ctx.changes) {
    return error(409, { error: "revision_already_requested", ...changesInfo(ctx, o) });
  }
  const sigDeadline = Math.min(now + SIG_TTL_S, endsAt);
  return json(200, {
    order_id: o.id,
    decision: b.data.decision,
    typed_data: typedDataJson(typedFor(b.data.decision, o.terms_hash as Hex, sigDeadline, s.cfg.factory)),
    sig_deadline: sigDeadline,
    review_ends_at: reviewEnd,
    preview_url: o.revision_preview_url ?? q.preview_url,
    note:
      b.data.decision === "changes"
        ? `Signing this asks for the one included revision; it is not a Decision and cannot move money. ${CHANGES_POLICY}`
        : "Sign typed_data with request_wallet_sign (EIP-712, no gas), then call submit with the signature.",
    ...changesInfo(ctx, o),
    ...(b.data.decision === "changes" ? { policy: CHANGES_POLICY } : {}),
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
  const ctx = await load(s, orderId, b.data.access_token, b.data.decision);
  if (ctx instanceof Response) return ctx;
  const { o, t, now } = ctx;
  const { signature, sig_deadline: sigDeadline, decision } = b.data;
  if (!signature || sigDeadline === undefined) return error(400, { error: "signature_and_sig_deadline_required" });
  if (sigDeadline <= now || sigDeadline > now + 2 * SIG_TTL_S) return error(400, { error: "bad_sig_deadline" });
  if (decision === "changes" && ctx.changes) {
    return error(409, { error: "revision_already_requested", ...changesInfo(ctx, o) });
  }
  const td = typedFor(decision, o.terms_hash as Hex, sigDeadline, s.cfg.factory);
  if (!(await signedByBuyer(s, t.buyer, td, signature as Hex))) return error(401, { error: "invalid_signature" });

  if (decision === "changes") {
    await s.repo.updateOrder(o.id, { change_requested_at: now }, now);
    s.log.info("studio_changes_requested", { order_id: o.id });
    const { acceptBy } = studioWindows(o, t);
    return json(200, {
      order_id: o.id,
      decision,
      tx: null,
      state: "changes_requested",
      status: "changes_requested",
      accept_by: acceptBy,
      policy: CHANGES_POLICY,
    });
  }

  if (ctx.phase === "after_changes") {
    // decideBySig is no longer valid on-chain: the buyer's signed Decision is the authorization, checked above.
    if (decision === "accept") {
      await s.repo.updateOrder(o.id, { buyer_accepted_at: now }, now);
      s.log.info("studio_accepted_offchain", { order_id: o.id });
      const next = await s.repo.getOrder(o.id);
      if (next) background(advanceOrder(s, next, 8_000).catch(() => undefined));
      return json(200, {
        order_id: o.id,
        decision,
        tx: null,
        state: "accepted",
        status: "accepted",
        policy: CHANGES_POLICY,
      });
    }
    const r = await runAction(s, o, "cancel", encodeFactoryCall.cancel(t), 8_000);
    if (r.state === "busy") return error(409, { error: "order_busy", detail: "retry shortly" });
    if (r.state !== "confirmed" && r.state !== "pending") {
      return error(502, { error: "relay_failed", detail: errorText(r.reason ?? r.state, 160) });
    }
    return json(200, { order_id: o.id, decision, tx: r.hash, state: r.state, status: r.state, refund: "full" });
  }

  const accept = decision === "accept";
  const data = encodeFactoryCall.decideBySig(t, accept, BigInt(sigDeadline), signature as Hex);
  const r = await runAction(s, o, "decide", data, 8_000);
  if (r.state === "busy") return error(409, { error: "order_busy", detail: "retry shortly" });
  if (r.state !== "confirmed" && r.state !== "pending") {
    return error(502, { error: "relay_failed", detail: errorText(r.reason ?? r.state, 160) });
  }
  if (accept && r.state === "confirmed") {
    const next = await s.repo.getOrder(o.id);
    if (next) background(advanceOrder(s, next, 8_000).catch(() => undefined));
  }
  return json(200, { order_id: o.id, decision, tx: r.hash, state: r.state, status: r.state, ...changesInfo(ctx, o) });
}
