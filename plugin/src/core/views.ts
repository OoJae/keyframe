// Structured quote view and the quote-card text (product-render-demo.md §A5 template). The card's wording is part of
// the frozen bundle: plain English, the "sealed envelope" metaphor, only claims this plugin itself checked.

import type { Check } from "./checks.js";
import { failed } from "./checks.js";
import type { QuoteReview } from "./quote.js";
import { etaText, formatTitle } from "./quote.js";
import { capJson, chunkAddr, clean, eth, quoted, shortAddr, usdc, utc } from "./text.js";
import type { Route } from "./wallet.js";

export type NextStep = { tool: string | null; input: Record<string, unknown>; note: string };

/**
 * The payment tools' input: the quote id plus what binds the payment to the deal reviewed here (H1). The buyer is
 * the wallet the deal refunds to and terms_hash the locally derived deal hash; a payment tool refuses if the
 * backend serves anything else.
 */
export const payInput = (r: QuoteReview) => ({
  quote_id: r.quote.quote_id,
  buyer: r.terms.buyer,
  terms_hash: r.derived.termsHash,
});

const inline = (o: Record<string, string>) =>
  `{${Object.entries(o)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(", ")}}`;

/** The quote is being (or was) paid already: Keyframe's settling flag or the live 402 says so. */
const alreadyPaying = (r: QuoteReview): boolean =>
  (r.probe !== null && !r.probe.ok && (r.probe.reason === "paid" || r.probe.reason === "settling")) ||
  r.checks.some((c) => c.id === "quote_final" && c.status === "fail" && /being settled/.test(c.detail));

export function nextForQuote(r: QuoteReview): NextStep {
  const q = r.quote;
  const amount = usdc(r.terms.amount);
  if (q.status === "draft") {
    const wait = Math.max(1, Math.ceil(q.retry_after_ms / 1000));
    return {
      tool: "keyframe_status",
      input: { quote_id: q.quote_id, wait_s: 6, buyer: r.terms.buyer },
      note: `The key-frame preview is rendering. Call keyframe_status with this quote_id and buyer in about ${wait} s; it finalizes the quote.`,
    };
  }
  if (alreadyPaying(r)) {
    return {
      tool: "keyframe_status",
      input: { quote_id: q.quote_id, wait_s: 6, buyer: r.terms.buyer },
      note: 'A payment for this quote is already settled or still settling. Do not pay again; poll keyframe_status, then call keyframe_verify with mode "funding".',
    };
  }
  if (q.status !== "final" || r.fatal.length > 0) {
    return { tool: null, input: {}, note: "This quote cannot be paid. Ask for a new quote with keyframe_quote." };
  }
  const route = r.route;
  if (route?.kind === "fund_first") {
    return {
      tool: "get_buy_link",
      input: {},
      note: `Core PayBox tool. ${route.reason}. Then call keyframe_status with quote_id ${q.quote_id} and buyer ${r.terms.buyer} (valid until ${utc(q.quote_expires_at)}) or quote again.`,
    };
  }
  if (route?.kind === "direct") {
    return {
      tool: "keyframe_commission_direct",
      input: payInput(r),
      note: `One Base transaction: USDC.transfer(${r.derived.escrow}, ${r.terms.amount}). Use the wallet_id of buyer wallet ${r.terms.buyer}. Needs a little ETH for gas. Pass input exactly (buyer and terms_hash bind the payment to this deal).`,
    };
  }
  return {
    tool: "keyframe_commission",
    input: payInput(r),
    note: `Use the wallet_id of buyer wallet ${r.terms.buyer}. PayBox will show payee ${chunkAddr(r.derived.escrow)} and ${amount} USDC; compare the whole address. Pass input exactly (buyer and terms_hash bind the payment to this deal). After approval poll get_request; never call keyframe_commission twice for one quote.`,
  };
}

export function quoteView(r: QuoteReview, summary: string): Record<string, unknown> {
  const q = r.quote;
  const payable = q.status === "final" && r.fatal.length === 0;
  return {
    quote_id: q.quote_id,
    quote_status: q.status,
    payable,
    summary: clean(summary, 600),
    tier: q.tier,
    format: clean(q.format, 64),
    price: { atomic: r.terms.amount.toString(), usdc: usdc(r.terms.amount) },
    eta_s: q.eta_s,
    quote_expires_at: q.quote_expires_at,
    deadline: r.terms.deadline,
    deadline_utc: utc(r.terms.deadline),
    preview: {
      still_url: r.preview.still,
      still_sha256: q.preview.still_sha256?.toLowerCase() ?? null,
      video_url: r.preview.video,
      frame_ms: q.spec.keyframe?.atMs ?? null,
    },
    escrow: {
      address: r.derived.escrow,
      code: r.escrow.code,
      balance_atomic: r.escrow.balance === null ? null : r.escrow.balance.toString(),
      derivation: r.derived.derivation,
    },
    terms: q.terms,
    terms_hash: r.derived.termsHash,
    spec_hash: q.spec_hash.toLowerCase(),
    delivery: q.delivery,
    route: r.route,
    checks: r.checks,
    disclosures: (capJson(q.disclosures.slice(0, 12)) as string[]).map((d) => clean(d, 500)),
    retry_after_ms: q.retry_after_ms,
    next: nextForQuote(r),
  };
}

const passed = (checks: readonly Check[], id: string) => checks.some((c) => c.id === id && c.status === "pass");

function routeLine(route: Route | null): string {
  if (!route) return "";
  const w = route.wallet;
  const kind =
    w.kind === "plain"
      ? "plain wallet"
      : w.kind === "delegated"
        ? "smart-account mode (EIP-7702)"
        : w.kind === "contract"
          ? "smart-contract wallet"
          : "not readable";
  const bal = w.usdc_atomic === null ? "" : `, ${usdc(w.usdc_atomic)} USDC`;
  const gas = route.kind === "direct" && w.eth_wei !== null ? `, ${eth(BigInt(w.eth_wei))} ETH` : "";
  const label =
    route.kind === "x402"
      ? "x402 (one approval, no gas)"
      : route.kind === "direct"
        ? "direct USDC transfer (one approval, needs a little ETH for gas)"
        : "fund first";
  return `Wallet ${shortAddr(w.address)}: ${kind}${bal}${gas} → route: ${label}`;
}

/** The quote card (content[0].text of keyframe_quote and keyframe_status for a quote). */
export function quoteCard(r: QuoteReview): string {
  const q = r.quote;
  const t = r.terms;
  const amount = usdc(t.amount);
  const style = quoted(q.spec.style, 32);
  const head = `Keyframe quote ${q.quote_id}: ${formatTitle(q.spec.format)} · ${style} style · ${q.spec.aspect} · ${q.spec.durationS} s`;
  if (q.status === "draft") {
    return [
      head,
      `Price ${amount} USDC on Base · deadline ${utc(t.deadline)}`,
      `The key-frame preview is still rendering, so this quote is not payable yet. Next: keyframe_status {quote_id:"${q.quote_id}"} in about ${Math.max(1, Math.ceil(q.retry_after_ms / 1000))} s.`,
    ].join("\n");
  }
  const lines = [head];
  const studio = q.tier === "studio";
  lines.push(
    studio
      ? `Price ${amount} USDC on Base · made by hand by Keyframe's designer · delivery by ${utc(t.deadline)}, then ${Math.round(t.reviewWindow / 3600)} h to review (miss the delivery deadline → full refund, automatic)`
      : `Price ${amount} USDC on Base · usually ready in ${etaText(q.eta_s)} · deadline ${utc(t.deadline)} (miss it → full refund, automatic)`,
  );
  if (studio) {
    const fee = usdc((t.amount * BigInt(t.killFeeBps)) / 10_000n);
    lines.push(
      `Review after delivery: accept, ask for one revision, or reject (the designer keeps the agreed kill fee of ${fee} USDC, the rest returns to you). With no change request, silence until the review window ends counts as accept; after a change request, Keyframe releases payment only on your explicit accept.`,
    );
  }
  // L2: only a plain link on Keyframe's own hosts, and quoted as data.
  if (r.preview.still) lines.push(`Key frame preview (watermarked): ${quoted(r.preview.still, 600)}`);
  const empty = r.escrow.code === "none" ? " Nothing is deployed there yet." : "";
  lines.push(
    `Sealed envelope: ${shortAddr(r.derived.escrow)} (full: ${r.derived.escrow}).${empty} The address is computed from this`,
    `deal, so the money can pay the studio only if the key to your file is published before the deadline; otherwise it can`,
    `only come back to you.`,
    `Refunds can only go to the buyer wallet ${t.buyer}${r.buyerChecked ? " (the wallet this quote was requested for)" : "; pass buyer to keyframe_status to check that it is yours"}.`,
  );
  const marks = [
    `address recomputed ${passed(r.checks, "escrow_address") ? "✓" : "✗"}`,
    `live payment request pays exactly ${amount} USDC to it ${passed(r.checks, "live_402") ? "✓" : "✗"}`,
    `preview matches the deal ${passed(r.checks, "preview_matches_deal") ? "✓" : "–"}`,
  ];
  lines.push(`Checks by this plugin: ${marks.join(" · ")}`);
  const bad = failed(r.checks);
  if (bad.length > 0) {
    lines.push(`NOT PAYABLE. Failed: ${bad.map((c) => `${c.id} (${c.detail})`).join("; ")}`);
    const after = nextForQuote(r);
    if (after.tool) lines.push(`Next: ${after.tool} (${after.note})`);
    return lines.join("\n");
  }
  const route = routeLine(r.route);
  if (route) lines.push(route);
  const next = nextForQuote(r);
  if (next.tool === "keyframe_commission") {
    lines.push(
      `Next: keyframe_commission ${inline(payInput(r))}. PayBox will show payee ${chunkAddr(r.derived.escrow)} and ${amount} USDC; compare the whole address, not only its ends. (keyframe_commission_direct with the same input instead fixes the payee inside the transaction itself; it needs a little ETH for gas.)`,
    );
  } else if (next.tool === "keyframe_commission_direct") {
    lines.push(
      `Next: keyframe_commission_direct ${inline(payInput(r))}. PayBox will show "to" = the USDC contract, with the envelope ${chunkAddr(r.derived.escrow)} and ${amount} USDC inside the data.`,
    );
  } else if (next.tool) {
    lines.push(`Next: ${next.note}`);
  }
  return lines.join("\n");
}
