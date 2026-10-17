// keyframe_review: Studio review in two calls. The plugin cannot request signatures itself, so stage 1 returns an
// EIP-712 message for core request_wallet_sign (accept/reject: the plugin's canonical Decision after checking the
// backend's; changes: the plugin's own ChangeRequest, never the backend's object), and stage 2 recovers the signer
// locally (it must be the buyer) before relaying it through Keyframe's API (decideBySig is gasless for the buyer).
//
// 'changes' semantics (Keyframe's API, ADR-019): with no change request, silence until the review window ends counts
// as accept. After one, nothing is released on silence: one revision may be delivered, and only the buyer's explicit
// accept releases (decideBySig inside the on-chain window; after it, until the order view's changes.accept_by, a
// signed Decision(accept) verified off-chain by Keyframe, whose operator releases). A reject after the window is
// answered with a full-refund cancel; without an accept the keeper refunds at review end + grace.

import { type Address, type Hex, isAddressEqual, recoverTypedDataAddress } from "viem";
import { apiFailure, apiRequest } from "../core/api.js";
import { statusName } from "../core/chain.js";
import { loadConfig } from "../core/config.js";
import { RELEASE_GRACE_S } from "../core/deal.js";
import { Budget } from "../core/net.js";
import { snapshot } from "../core/onchain.js";
import { type Changes, changesOf, resolveOrder } from "../core/resolve.js";
import { dataResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { clean, nowSeconds, quoted, shortAddr, usdc, utc } from "../core/text.js";
import {
  CHANGE_SIG_TTL_S,
  changeRequestPayload,
  changeRequestTypedData,
  checkReviewTypedData,
  decisionPayload,
  MAX_SIG_LIFETIME_S,
} from "../core/typed.js";
import { DECISION_TYPES, Status } from "../protocol/index.js";
import { ReviewInput, ReviewOutput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

export const reviewTool = defineTool({
  name: "keyframe_review",
  ...COPY.keyframe_review,
  inputSchema: ReviewInput,
  outputSchema: ReviewOutput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: (input) =>
    guarded(async () => {
      const cfg = loadConfig();
      const budget = new Budget();
      const r = await resolveOrder(
        cfg,
        budget,
        { order_id: input.order_id, access_token: input.access_token },
        NOTHING_MOVED,
      );
      const bad = r.checks.filter((c) => c.status === "fail");
      if (bad.length > 0)
        throw new ToolError(`This order does not check out (${bad.map((c) => c.detail).join("; ")}). ${NOTHING_MOVED}`);
      const now = nowSeconds();
      const accept = input.decision === "changes" ? null : input.decision === "accept";
      const factories = cfg.factories.map((f) => f.address);
      type Phase = { buyer: Address; closes: number; changes: Changes | null; afterWindow: boolean; endsAt: number };
      // Where the order stands. Inside the on-chain review window a decision is relayed with decideBySig. After it,
      // only an order with a change request still waits on the buyer: Keyframe accepts a signed accept (verified
      // off-chain, then its operator releases) or a reject (answered with a full-refund cancel) until accept_by.
      const phaseOf = (o: Awaited<ReturnType<typeof snapshot>>["order"]): Phase => {
        if (!o)
          throw new ToolError(
            `Could not read this order on Base, so it cannot be reviewed safely right now. ${NOTHING_MOVED}`,
          );
        if (o.status !== Status.Delivered) {
          throw new ToolError(`This order is not in review on Base (it is ${statusName(o.status)}). ${NOTHING_MOVED}`);
        }
        const closes = Number(o.deliveredAt) + o.reviewWindow;
        const changes = changesOf(r.order, closes);
        const accepted = o.accepted || r.order?.accepted === true;
        if (now < closes) {
          if (o.accepted && input.decision !== "accept")
            throw new ToolError(`This delivery was already accepted. ${NOTHING_MOVED}`);
          return { buyer: o.buyer as Address, closes, changes, afterWindow: false, endsAt: closes };
        }
        if (!changes) {
          throw new ToolError(
            `The review window closed at ${utc(closes)} with no change request, so no decision can be signed any more (doing nothing counted as accept). ${NOTHING_MOVED}`,
          );
        }
        if (input.decision === "changes") {
          throw new ToolError(
            `A change request was already made and the review window closed at ${utc(closes)}; only accept or reject remain. ${NOTHING_MOVED}`,
          );
        }
        if (changes.acceptBy === null || now >= changes.acceptBy) {
          throw new ToolError(
            `The time to accept after the change request has passed${changes.acceptBy === null ? "" : ` (${utc(changes.acceptBy)})`}; nothing was released, and the USDC returns to the buyer in full after ${utc(closes + RELEASE_GRACE_S)}. ${NOTHING_MOVED}`,
          );
        }
        if (accepted) throw new ToolError(`This delivery was already accepted. ${NOTHING_MOVED}`);
        return { buyer: o.buyer as Address, closes, changes, afterWindow: true, endsAt: changes.acceptBy };
      };

      if (input.signature === undefined) {
        const [s, res] = await Promise.all([
          snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow),
          apiRequest(cfg, budget, `/v1/reviews/${input.order_id}/challenge`, {
            method: "POST",
            body: { access_token: input.access_token, decision: input.decision },
          }),
        ]);
        const { buyer, closes, changes, afterWindow, endsAt } = phaseOf(s.order);
        if (res.status !== 200) throw apiFailure(res, NOTHING_MOVED);
        let deadline: number;
        let typed: Record<string, unknown>;
        if (accept === null) {
          // H2: the change request is built here, never taken from the backend (whose typed data is ignored): the
          // Keyframe Escrow domain of this order's allowlisted factory on Base, this order's termsHash, a deadline of
          // at most 1 h (and never past the review window). It is not a Decision, so the factory cannot act on it.
          deadline = Math.min(now + CHANGE_SIG_TTL_S, closes);
          typed = changeRequestPayload(r.factory.address, r.termsHash, deadline);
        } else {
          const td = (res.json as { typed_data?: unknown } | null)?.typed_data;
          const checked = checkReviewTypedData(td, {
            factories,
            factory: r.factory.address,
            termsHash: r.termsHash,
            accept,
            now,
          }).deadline;
          // Built locally, never the backend's object; its deadline is at most 7 days away (checked above) and never
          // later than this phase allows: the review end, or accept_by after a change request.
          deadline = Math.min(checked, endsAt);
          if (deadline <= now) throw new ToolError(`The time for this decision has passed. ${NOTHING_MOVED}`);
          typed = decisionPayload(r.factory.address, r.termsHash, accept, deadline);
        }
        const fee = r.terms ? usdc((r.terms.amount * BigInt(r.terms.killFeeBps)) / 10_000n) : null;
        const graceEnd = utc(closes + RELEASE_GRACE_S);
        const policy = changes?.policy ? ` Keyframe's policy: ${quoted(changes.policy, 400)}` : "";
        const effect =
          input.decision === "accept"
            ? afterWindow
              ? "accept: the on-chain review window has closed, so Keyframe verifies this signed accept itself and its operator then releases the payment to the designer (the key to the file is published)"
              : "accept: the key to the file is published and the designer is paid now"
            : input.decision === "reject"
              ? afterWindow
                ? `reject: Keyframe voids the order (cancel) and the full amount returns to ${shortAddr(buyer)}, with no kill fee`
                : `reject: the delivery is refused; ${fee === null ? "the agreed kill fee (if any) goes to the designer and " : `the designer keeps the agreed kill fee of ${fee} USDC and `}the rest returns to ${shortAddr(buyer)}`
              : `changes: asks the designer for the one included revision (this signature only authenticates the request; it cannot move money). After a change request nothing is released on silence: Keyframe releases the payment only on the buyer's explicit accept, possible until the order's changes.accept_by (shortly before ${graceEnd}; the revision may be delivered once); otherwise the USDC returns to the buyer in full after ${graceEnd}`;
        const note =
          accept === null
            ? `After this change request nothing is released on silence: payment only on an explicit accept (until changes.accept_by, shortly before ${graceEnd}); otherwise the USDC returns to the buyer in full after ${graceEnd}.`
            : changes
              ? `A change request was made${changes.revisionDelivered ? " and a revision was delivered" : ""}: nothing is released on silence. Accept or reject by ${utc(changes.acceptBy ?? endsAt)}; without an accept the USDC returns to the buyer in full after ${graceEnd}.`
              : `Review window closes ${utc(closes)}. With no change request, doing nothing until then counts as accept.`;
        return dataResult(
          [
            afterWindow
              ? `Studio review for order ${input.order_id}: the on-chain review window closed at ${utc(closes)}, but after the change request the buyer can still accept or reject until ${utc(endsAt)}. Decision: ${effect}.`
              : `Studio review for order ${input.order_id} (review open until ${utc(closes)}). Decision: ${effect}.`,
            `${note}${policy}`,
            `Confirm with the user, then sign the typed_data in structuredContent with core request_wallet_sign (EIP-712, no gas) from the buyer wallet ${buyer}.`,
            accept === null
              ? `Built by this plugin, not taken from Keyframe's API: a ChangeRequest for this order only, under Keyframe's allowlisted escrow factory ${shortAddr(r.factory.address)} on Base, valid until ${utc(deadline)}; it is not a Decision, so the escrow cannot act on it.`
              : `Built by this plugin after checking Keyframe's message: a Decision for Keyframe's allowlisted escrow factory ${shortAddr(r.factory.address)} on Base, for this order only, saying ${input.decision}, valid until ${utc(deadline)}.`,
            `Then call keyframe_review again with order_id, access_token, decision "${input.decision}", signature and sig_deadline ${deadline}.`,
          ].join("\n"),
          {
            stage: "sign",
            decision: input.decision,
            order_id: input.order_id,
            typed_data: typed,
            sign_with: `core request_wallet_sign (EIP-712 typed data) from ${buyer}`,
            sig_deadline: deadline,
            signer: null,
            tx: null,
            status: null,
            note: clean(note, 800),
          },
        );
      }

      // Stage 2 keeps to the budget: the buyer comes from the re-hashed terms when available, else from Base.
      const buyer = r.terms
        ? r.terms.buyer
        : phaseOf((await snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow)).order).buyer;
      const sigDeadline = input.sig_deadline as number;
      if (sigDeadline <= now)
        throw new ToolError(
          `The signed message expired at ${utc(sigDeadline)}; start the review again. ${NOTHING_MOVED}`,
        );
      if (sigDeadline > now + MAX_SIG_LIFETIME_S)
        throw new ToolError(`sig_deadline is more than 7 days away; start the review again. ${NOTHING_MOVED}`);
      // Every decision, "changes" included, is recovered here and must be signed by the buyer before it is relayed.
      let signer: Address;
      const signature = input.signature as Hex;
      try {
        signer =
          accept === null
            ? await recoverTypedDataAddress({
                ...changeRequestTypedData(r.factory.address, r.termsHash, sigDeadline),
                signature,
              })
            : await recoverTypedDataAddress({
                domain: { name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: r.factory.address },
                types: DECISION_TYPES,
                primaryType: "Decision",
                message: { termsHash: r.termsHash, accept, deadline: BigInt(sigDeadline) },
                signature,
              });
      } catch {
        throw new ToolError(`The signature is malformed. ${NOTHING_MOVED}`);
      }
      if (!isAddressEqual(signer, buyer)) {
        throw new ToolError(
          `The signature is not from the buyer wallet ${buyer} for this ${accept === null ? "change request" : "decision"} (it recovers to ${signer}); sign the typed_data from the first call with the buyer wallet. ${NOTHING_MOVED}`,
        );
      }
      const res = await apiRequest(cfg, budget, `/v1/reviews/${input.order_id}/submit`, {
        method: "POST",
        body: {
          access_token: input.access_token,
          decision: input.decision,
          signature: input.signature,
          sig_deadline: sigDeadline,
        },
      });
      if (res.status !== 200 && res.status !== 202) throw apiFailure(res, "The decision was not submitted.");
      const body = (res.json ?? {}) as { tx?: unknown; status?: unknown; accept_by?: unknown; refund?: unknown };
      const tx = typeof body.tx === "string" && TX_RE.test(body.tx) ? body.tx.toLowerCase() : null;
      const status = typeof body.status === "string" ? clean(body.status, 64) : null;
      const acceptBy =
        typeof body.accept_by === "number" && Number.isSafeInteger(body.accept_by) && body.accept_by > now
          ? body.accept_by
          : null;
      const outcome =
        accept === null
          ? `The change request is recorded off-chain by Keyframe; nothing moves on Base. From now on nothing is released on silence: only the buyer's explicit accept${acceptBy === null ? "" : ` (possible until ${utc(acceptBy)})`} releases the payment; otherwise the USDC returns to the buyer in full after the review window plus 3 days.`
          : status === "accepted" && tx === null
            ? "Keyframe recorded the buyer's signed accept after the review window (verified off-chain); its operator now releases the payment and publishes the key."
            : body.refund === "full"
              ? `Keyframe is voiding the order: the full amount returns to the buyer.${tx ? ` Transaction: ${tx}.` : ""}`
              : tx
                ? `Relay transaction: ${tx}.`
                : "Keyframe will relay it on Base shortly.";
      return dataResult(
        [
          `Decision "${input.decision}" for order ${input.order_id} submitted (signed by the buyer ${shortAddr(signer)}, checked here).`,
          outcome,
          accept === null
            ? `Next: keyframe_status {order_id:"${input.order_id}"} to follow the revision, then keyframe_review accept or reject${acceptBy === null ? "" : ` before ${utc(acceptBy)}`}.`
            : `Next: keyframe_status {order_id:"${input.order_id}"} in a minute, then keyframe_verify ${input.decision === "accept" ? "delivery" : "funding"}.`,
        ].join("\n"),
        {
          stage: "submitted",
          decision: input.decision,
          order_id: input.order_id,
          typed_data: null,
          sign_with: null,
          sig_deadline: sigDeadline,
          signer,
          tx,
          status,
          note:
            accept === null
              ? "Change request submitted. After it, nothing is released on silence; only an explicit accept pays the designer."
              : tx === null && status === "accepted"
                ? "Accepted off-chain after the review window; Keyframe's operator releases the payment."
                : "The decision takes effect when the relay transaction is confirmed on Base.",
        },
      );
    }, NOTHING_MOVED),
});
