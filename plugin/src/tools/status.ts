import { getQuote } from "../core/api.js";
import { type Config, findFactory, loadConfig } from "../core/config.js";
import { derive } from "../core/deal.js";
import { envelopeOf } from "../core/envelope.js";
import { Budget } from "../core/net.js";
import { type Snapshot, snapshot } from "../core/onchain.js";
import { reviewQuote } from "../core/quote.js";
import { fetchOrder, resolveOrder } from "../core/resolve.js";
import { dataResult, guarded, NOTHING_MOVED } from "../core/result.js";
import { capJson, clean, nowSeconds, shortAddr, usdc, utc } from "../core/text.js";
import { type NextStep, quoteCard, quoteView } from "../core/views.js";
import { type Quote, Status, termsFromJson } from "../protocol/index.js";
import { StatusInput, StatusOutput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 1_500;

function nextFor(
  s: Snapshot | null,
  ids: { quote_id?: string; order_id?: string },
  deadline: number | null,
  now: number,
): {
  next: NextStep;
  poll: number | null;
} {
  const ref = ids.order_id ? { order_id: ids.order_id } : { quote_id: ids.quote_id };
  const status = s?.order?.status;
  if (status === Status.Released) {
    return {
      next: {
        tool: "keyframe_verify",
        input: { mode: "delivery", ...ref },
        note: "The key is published. Verify the file independently (private orders: also pass k_buyer).",
      },
      poll: null,
    };
  }
  if (status === Status.Refunded || status === Status.Cancelled || status === Status.Rejected) {
    return {
      next: {
        tool: "keyframe_verify",
        input: { mode: "funding", ...ref },
        note: "The order is closed; verify where the money went.",
      },
      poll: null,
    };
  }
  if (status === Status.Delivered) {
    return {
      next: {
        tool: "keyframe_review",
        input: { order_id: ids.order_id ?? null },
        note: "The Studio delivery is in review: accept, ask for changes or reject (pass the access_token).",
      },
      poll: 60,
    };
  }
  const sealed = status === Status.Open || (s?.balance !== undefined && s.balance > 0n);
  if (sealed && deadline !== null && now > deadline) {
    return {
      next: {
        tool: "keyframe_refund",
        input: { action: "refund", ...ref },
        note: "The deadline has passed with funds still in escrow. Keepers normally refund automatically; this is the manual fallback.",
      },
      poll: 30,
    };
  }
  return {
    next: {
      tool: "keyframe_status",
      input: { ...ref, wait_s: 6 },
      note: "Check again shortly (pass access_token for private orders).",
    },
    poll: sealed ? 5 : 10,
  };
}

async function quoteStatus(cfg: Config, budget: Budget, quoteId: string, waitS: number) {
  let quote: Quote = await getQuote(cfg, budget, quoteId, NOTHING_MOVED);
  const waitUntil = Date.now() + waitS * 1000;
  while (quote.status === "draft" && Date.now() + POLL_MS < waitUntil && budget.remaining() > 5_500) {
    await sleep(Math.min(POLL_MS, Math.max(250, quote.retry_after_ms)));
    quote = await getQuote(cfg, budget, quoteId, NOTHING_MOVED);
  }
  const now = nowSeconds();
  if (quote.status === "final" || quote.status === "draft") {
    const review = await reviewQuote(cfg, budget, quote, { now, live: quote.status === "final", wallet: true });
    const card = quoteCard(review);
    const view = quoteView(review, card.split("\n")[0] ?? "");
    const env = envelopeOf(review.escrow.status ?? undefined, review.escrow.balance ?? undefined, review.terms.amount);
    return dataResult(card, {
      kind: "quote",
      envelope: env.envelope,
      meaning: env.meaning,
      summary: clean(card.split("\n")[0], 800),
      quote: view,
      order: null,
      onchain: null,
      poll_after_s: quote.status === "draft" ? Math.max(1, Math.ceil(quote.retry_after_ms / 1000)) : null,
      next: view.next,
    });
  }
  // paid / expired / cancelled: the chain is the source of truth for where the money is.
  const terms = termsFromJson(quote.terms);
  const entry = findFactory(cfg, quote.factory);
  const d = derive(terms, quote.factory, entry?.vaultImpl);
  const snap = entry ? await snapshot(cfg.rpcUrls, budget, entry, d.termsHash, d.escrow) : null;
  const env = envelopeOf(snap?.order?.status, snap?.balance, terms.amount);
  const { next, poll } = nextFor(snap, { quote_id: quoteId }, terms.deadline, now);
  const text = [
    `Keyframe quote ${quoteId} is ${quote.status}. Envelope ${shortAddr(d.escrow)}: ${env.envelope} (${env.meaning}).`,
    entry ? "" : "Its escrow factory is not in KEYFRAME_FACTORIES, so the chain state was not read.",
    `Next: ${next.tool ?? "nothing"} (${next.note})`,
  ]
    .filter(Boolean)
    .join("\n");
  return dataResult(text, {
    kind: "quote",
    envelope: env.envelope,
    meaning: env.meaning,
    summary: clean(text.split("\n")[0], 800),
    quote: null,
    order: null,
    onchain: snap?.view ?? null,
    poll_after_s: poll,
    next,
  });
}

function progressText(order: Record<string, unknown> | null): string {
  if (!order) return "";
  const p = order.progress;
  if (typeof p === "object" && p !== null) {
    const pr = p as Record<string, unknown>;
    const pct = typeof pr.percent === "number" ? `${Math.round(pr.percent)}%` : "";
    const left = typeof pr.eta_s === "number" ? `, about ${Math.round(pr.eta_s)} s left` : "";
    const stage = typeof pr.stage === "string" ? ` ${clean(pr.stage, 40)}` : "";
    if (pct || stage) return ` Keyframe reports:${stage} ${pct}${left}.`;
  }
  return typeof order.status === "string" ? ` Keyframe reports status "${clean(order.status, 40)}".` : "";
}

async function orderStatus(cfg: Config, budget: Budget, orderId: string, token: string | undefined, waitS: number) {
  const r = await resolveOrder(cfg, budget, { order_id: orderId, access_token: token }, NOTHING_MOVED);
  const amount = r.terms?.amount ?? r.paid?.amount;
  let snap = await snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow);
  const first = snap.order?.status;
  const waitUntil = Date.now() + waitS * 1000;
  while (snap.order?.status === first && Date.now() + POLL_MS < waitUntil && budget.remaining() > 4_500) {
    await sleep(POLL_MS);
    snap = await snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow);
  }
  let order = r.order;
  if (snap.order?.status !== first && budget.remaining() > 4_000) {
    order = capJson(await fetchOrder(cfg, budget, orderId, token, NOTHING_MOVED).catch(() => r.order)) as Record<
      string,
      unknown
    > | null;
  }
  const now = nowSeconds();
  const env = envelopeOf(snap.order?.status, snap.balance, amount);
  const deadline = r.terms?.deadline ?? (snap.order && snap.order.status !== 0 ? Number(snap.order.deadline) : null);
  const { next, poll } = nextFor(snap, { order_id: orderId }, deadline, now);
  const failedChecks = r.checks.filter((c) => c.status === "fail");
  const lines = [
    `Keyframe order ${orderId}: ${env.envelope}. ${env.meaning[0]?.toUpperCase()}${env.meaning.slice(1)}.${progressText(order)}`,
    `Envelope ${r.escrow}${amount !== undefined ? ` · ${usdc(amount)} USDC` : ""}${deadline ? ` · deadline ${utc(deadline)}` : ""} · read on ${snap.rpc.responded} of ${snap.rpc.configured} Base RPCs${snap.view.consistent ? "" : " (they DISAGREE; re-check shortly)"}.`,
    failedChecks.length > 0 ? `WARNING: ${failedChecks.map((c) => c.detail).join("; ")}.` : "",
    `Next: ${next.tool ?? "nothing"}: ${next.note}`,
  ].filter(Boolean);
  return dataResult(lines.join("\n"), {
    kind: "order",
    envelope: env.envelope,
    meaning: env.meaning,
    summary: clean(lines[0], 800),
    quote: null,
    order,
    onchain: snap.view,
    poll_after_s: poll,
    next,
  });
}

export const statusTool = defineTool({
  name: "keyframe_status",
  ...COPY.keyframe_status,
  inputSchema: StatusInput,
  outputSchema: StatusOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: (input) =>
    guarded(async () => {
      const cfg = loadConfig();
      const budget = new Budget();
      if (input.quote_id) return quoteStatus(cfg, budget, input.quote_id, input.wait_s);
      return orderStatus(cfg, budget, input.order_id as string, input.access_token, input.wait_s);
    }, NOTHING_MOVED),
});
