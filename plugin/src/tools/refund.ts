// keyframe_refund: buyer-side fallback proposals to the allowlisted escrow factory. refund(T), sweep(T, token) and
// decide(T, false) can only ever move funds to T.buyer (frozen-interfaces.md §3, I1/I8), so the checks here are:
// the factory is allowlisted (active or refund-only), T re-hashes to the escrow, and the action is allowed on-chain
// right now (with the exact time when it is not). Payment-only checks (402, seller allowlist) do not apply.

import { type Address, encodeFunctionData, type Hex, isAddressEqual, zeroAddress } from "viem";
import { ethRead, statusName, tokenRead } from "../core/chain.js";
import { checkLines, failed } from "../core/checks.js";
import { loadConfig } from "../core/config.js";
import { RELEASE_GRACE_S, termsJson } from "../core/deal.js";
import { Budget } from "../core/net.js";
import { crossChecked, snapshot } from "../core/onchain.js";
import { changesOf, resolveOrder } from "../core/resolve.js";
import { guarded, NOTHING_PROPOSED, ToolError, type ToolResult } from "../core/result.js";
import { nowSeconds, shortAddr, usdc, utc } from "../core/text.js";
import { proposeEvm } from "../paybox.js";
import { CAIP2, keyframeFactoryAbi, Status, type Terms } from "../protocol/index.js";
import { evmOutputSchema, RefundInput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

/** Chain time lags wall time by a block or two; never propose a call that would revert by a few seconds. */
const MARGIN_S = 15;

const tuple = (t: Terms) => {
  const j = termsJson(t);
  return {
    ...t,
    buyer: j.buyer,
    seller: j.seller,
    operator: j.operator,
    token: j.token,
    dueAt: BigInt(t.dueAt),
    deadline: BigInt(t.deadline),
  };
};

export const refundTool = defineTool({
  name: "keyframe_refund",
  ...COPY.keyframe_refund,
  inputSchema: RefundInput,
  outputSchema: evmOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: (input) =>
    guarded(async (): Promise<ToolResult> => {
      const cfg = loadConfig();
      const budget = new Budget();
      const r = await resolveOrder(cfg, budget, input, NOTHING_PROPOSED);
      const bad = failed(r.checks);
      if (bad.length > 0)
        throw new ToolError(`Refusing to propose; these checks failed:\n${checkLines(bad)}\n${NOTHING_PROPOSED}`);
      if (!r.terms) {
        throw new ToolError(
          `The factory needs the full deal terms for this call; pass terms (+ factory) or quote_id. ${NOTHING_PROPOSED}`,
        );
      }
      const t = r.terms;
      const sweepToken = (input.token ?? t.token) as Address;
      const extra =
        input.action === "sweep" && !isAddressEqual(sweepToken, t.token)
          ? [isAddressEqual(sweepToken, zeroAddress) ? ethRead(r.escrow) : tokenRead(sweepToken, r.escrow)]
          : [];
      const s = await snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow, extra);
      const o = s.order;
      if (!o || s.balance === undefined) {
        throw new ToolError(`Could not read the escrow on Base to check that this is allowed now. ${NOTHING_PROPOSED}`);
      }
      // L4: eligibility is decided only on two agreeing Base RPCs, never on the first answer alone.
      if (!crossChecked(s, extra)) {
        throw new ToolError(
          `Refusing to propose: ${s.rpc.responded} of ${s.rpc.configured} Base RPCs answered${s.view.consistent ? "" : " and they DISAGREE"}; this plugin proposes a refund, sweep or reject only when at least 2 independent Base RPCs agree on the escrow's state. Try again in a minute. ${NOTHING_PROPOSED}`,
        );
      }
      // The on-chain record of a registered deal must be these terms' (Keyframe's order_id -> terms mapping is
      // not trusted on its own word).
      if (o.status !== Status.None && (!isAddressEqual(o.buyer, t.buyer) || Number(o.deadline) !== t.deadline)) {
        throw new ToolError(
          `The on-chain record of this deal names a different buyer or deadline than these terms, so they do not describe this order. ${NOTHING_PROPOSED}`,
        );
      }
      const now = nowSeconds();
      const where = `escrow ${shortAddr(r.escrow)} (${statusName(o.status)}, holds ${usdc(s.balance)} USDC)`;
      let data: Hex;
      let what: string;

      if (input.action === "refund") {
        if (o.status >= Status.Released) {
          const sweepHint = s.balance > 0n ? ' It still holds USDC: use action "sweep" to return it to the buyer.' : "";
          throw new ToolError(
            `This order is already closed (${statusName(o.status)}); there is nothing to refund.${sweepHint} ${NOTHING_PROPOSED}`,
          );
        }
        const opensAt =
          o.status === Status.Delivered ? Number(o.deliveredAt) + t.reviewWindow + RELEASE_GRACE_S : t.deadline;
        if (now <= opensAt + MARGIN_S) {
          throw new ToolError(
            `Not refundable yet: ${where} becomes refundable after ${utc(opensAt)}. Until then the studio can still deliver; after it, Keyframe's keepers normally refund automatically. ${NOTHING_PROPOSED}`,
          );
        }
        if (o.status === Status.None && s.balance === 0n) {
          throw new ToolError(`The escrow holds no USDC, so there is nothing to refund. ${NOTHING_PROPOSED}`);
        }
        data = encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "refund", args: [tuple(t)] });
        what = `refund(T): returns the ${usdc(s.balance)} USDC in the envelope to the buyer ${t.buyer}`;
      } else if (input.action === "sweep") {
        const same = isAddressEqual(sweepToken, t.token);
        const held = same ? s.balance : s.rpc.get(extra[0] as ReturnType<typeof tokenRead>).value;
        if (same && o.status < Status.Released) {
          throw new ToolError(
            `The deal's USDC can only be swept after the order closes; it is ${statusName(o.status)}. Use action "refund" after the deadline. ${NOTHING_PROPOSED}`,
          );
        }
        if (held === undefined || held === 0n)
          throw new ToolError(`The escrow holds none of that asset; nothing to sweep. ${NOTHING_PROPOSED}`);
        data = encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "sweep", args: [tuple(t), sweepToken] });
        what = `sweep(T, ${isAddressEqual(sweepToken, zeroAddress) ? "ETH" : sweepToken}): returns what is left at the envelope to the buyer ${t.buyer}`;
      } else {
        if (t.reviewWindow === 0)
          throw new ToolError(`Only Studio orders have a review; this is an Instant order. ${NOTHING_PROPOSED}`);
        if (o.status !== Status.Delivered || o.accepted) {
          throw new ToolError(
            `Reject is only possible while a Studio delivery is in review; this order is ${statusName(o.status)}${o.accepted ? " (accepted)" : ""}. ${NOTHING_PROPOSED}`,
          );
        }
        const closesAt = Number(o.deliveredAt) + t.reviewWindow;
        if (now >= closesAt - MARGIN_S) {
          // After a change request Keyframe still takes a signed reject (answered with a full-refund cancel).
          const changes = changesOf(r.order, closesAt);
          const later =
            changes?.acceptBy && now < changes.acceptBy
              ? ` After the change request a reject is still possible through keyframe_review until ${utc(changes.acceptBy)}: Keyframe then voids the order and the full amount returns to the buyer.`
              : "";
          throw new ToolError(
            `The on-chain review window closed at ${utc(closesAt)}, so decide(T, false) would revert.${later} ${NOTHING_PROPOSED}`,
          );
        }
        data = encodeFunctionData({ abi: keyframeFactoryAbi, functionName: "decide", args: [tuple(t), false] });
        const fee = (t.amount * BigInt(t.killFeeBps)) / 10_000n;
        what = `decide(T, reject): the designer keeps the agreed kill fee of ${usdc(fee)} USDC, and the rest returns to the buyer ${t.buyer}. It must be sent from that buyer wallet`;
      }

      const proposal = proposeEvm({ chain: CAIP2, to: r.factory.address, value: "0", data });
      const text = [
        `Fallback proposal for ${where}: one Base transaction to the Keyframe escrow factory ${r.factory.address} calling ${what}.`,
        "The contract can only send these funds to the deal's buyer; nobody, including Keyframe, can redirect them.",
        "PayBox's window shows the factory as 'to', value 0, and the raw calldata. It needs a little ETH on Base for gas.",
        `Use the wallet_id of a wallet with Base ETH${input.action === "reject" ? ` (for reject: the buyer wallet ${t.buyer})` : ""}. After approval, poll get_request, then call keyframe_verify with mode funding.`,
      ].join("\n");
      return { ...proposal, content: [{ type: "text", text }] };
    }, NOTHING_PROPOSED),
});
