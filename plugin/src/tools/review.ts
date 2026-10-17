// keyframe_review: Studio review in two calls. The plugin cannot request signatures itself, so stage 1 returns a
// checked EIP-712 message for core request_wallet_sign, and stage 2 checks the signature locally (signer must be
// the buyer recorded on Base) before relaying it through Keyframe's API (decideBySig is gasless for the buyer).

import { type Address, type Hex, isAddressEqual, recoverTypedDataAddress } from "viem";
import { apiFailure, apiRequest } from "../core/api.js";
import { statusName } from "../core/chain.js";
import { loadConfig } from "../core/config.js";
import { Budget } from "../core/net.js";
import { snapshot } from "../core/onchain.js";
import { resolveOrder } from "../core/resolve.js";
import { dataResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { capJson, clean, nowSeconds, shortAddr, usdc, utc } from "../core/text.js";
import { checkReviewTypedData, decisionPayload } from "../core/typed.js";
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
      const inReview = (o: Awaited<ReturnType<typeof snapshot>>["order"]) => {
        if (!o)
          throw new ToolError(
            `Could not read this order on Base, so it cannot be reviewed safely right now. ${NOTHING_MOVED}`,
          );
        if (o.status !== Status.Delivered) {
          throw new ToolError(`This order is not in review on Base (it is ${statusName(o.status)}). ${NOTHING_MOVED}`);
        }
        const closes = Number(o.deliveredAt) + o.reviewWindow;
        if (now >= closes)
          throw new ToolError(`The review window closed at ${utc(closes)}; silence counts as accept. ${NOTHING_MOVED}`);
        if (o.accepted && input.decision !== "accept")
          throw new ToolError(`This delivery was already accepted. ${NOTHING_MOVED}`);
        return { buyer: o.buyer as Address, closes };
      };

      if (input.signature === undefined) {
        const [s, res] = await Promise.all([
          snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow),
          apiRequest(cfg, budget, `/v1/reviews/${input.order_id}/challenge`, {
            method: "POST",
            body: { access_token: input.access_token, decision: input.decision },
          }),
        ]);
        const { buyer, closes } = inReview(s.order);
        if (res.status !== 200) throw apiFailure(res, NOTHING_MOVED);
        const td = (res.json as { typed_data?: unknown } | null)?.typed_data;
        const checked = checkReviewTypedData(td, {
          factories,
          factory: r.factory.address,
          termsHash: r.termsHash,
          accept,
          now,
        });
        const deadline = checked.deadline;
        // For a Decision the plugin returns its own canonical payload (identical fields), never the backend's object.
        const typed =
          accept === null
            ? (capJson(td, { maxString: 500, maxArray: 32, maxKeys: 32, maxDepth: 6 }) as Record<string, unknown>)
            : decisionPayload(r.factory.address, r.termsHash, accept, deadline as number);
        const fee = r.terms ? usdc((r.terms.amount * BigInt(r.terms.killFeeBps)) / 10_000n) : null;
        const effect =
          input.decision === "accept"
            ? "accept: the key to the file is published and the designer is paid now"
            : input.decision === "reject"
              ? `reject: the delivery is refused; ${fee === null ? "the agreed kill fee (if any) goes to the designer and " : `the designer keeps the agreed kill fee of ${fee} USDC and `}the rest returns to ${shortAddr(buyer)}`
              : "changes: asks the designer for the one included revision (this signature authenticates the request; it cannot move money)";
        return dataResult(
          [
            `Studio review for order ${input.order_id} (review open until ${utc(closes)}). Decision: ${effect}.`,
            `Confirm with the user, then sign the typed_data in structuredContent with core request_wallet_sign (EIP-712, no gas) from the buyer wallet ${buyer}.`,
            `Checked by this plugin: the message is for Keyframe's allowlisted escrow factory ${shortAddr(r.factory.address)} on Base and for this order only${accept === null ? "" : `, and it says ${input.decision}`}.`,
            `Then call keyframe_review again with order_id, access_token, decision "${input.decision}", signature${deadline === null ? "" : ` and sig_deadline ${deadline}`}.`,
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
            note: clean(`Review window closes ${utc(closes)}. Doing nothing until then counts as accept.`, 800),
          },
        );
      }

      // Stage 2 keeps to the budget: the buyer comes from the re-hashed terms when available, else from Base.
      const buyer = r.terms
        ? r.terms.buyer
        : inReview((await snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow)).order).buyer;
      const sigDeadline = input.sig_deadline as number;
      if (sigDeadline <= now)
        throw new ToolError(
          `The signed message expired at ${utc(sigDeadline)}; start the review again. ${NOTHING_MOVED}`,
        );
      let signer: Address | null = null;
      if (accept !== null) {
        try {
          signer = await recoverTypedDataAddress({
            domain: { name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: r.factory.address },
            types: DECISION_TYPES,
            primaryType: "Decision",
            message: { termsHash: r.termsHash, accept, deadline: BigInt(sigDeadline) },
            signature: input.signature as Hex,
          });
        } catch {
          throw new ToolError(`The signature is malformed. ${NOTHING_MOVED}`);
        }
        if (!isAddressEqual(signer, buyer)) {
          throw new ToolError(
            `The signature is not from the buyer wallet ${buyer} (it recovers to ${signer}); sign with the buyer wallet. ${NOTHING_MOVED}`,
          );
        }
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
      const body = (res.json ?? {}) as { tx?: unknown; status?: unknown };
      const tx = typeof body.tx === "string" && TX_RE.test(body.tx) ? body.tx.toLowerCase() : null;
      const status = typeof body.status === "string" ? clean(body.status, 64) : null;
      return dataResult(
        [
          `Decision "${input.decision}" for order ${input.order_id} submitted${signer ? ` (signed by the buyer ${shortAddr(signer)}, checked here)` : ""}.`,
          tx ? `Relay transaction: ${tx}.` : "Keyframe will relay it on Base shortly.",
          `Next: keyframe_status {order_id:"${input.order_id}"} in a minute, then keyframe_verify ${input.decision === "accept" ? "delivery" : "funding"}.`,
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
          note: "The decision takes effect when the relay transaction is confirmed on Base.",
        },
      );
    }, NOTHING_MOVED),
});
