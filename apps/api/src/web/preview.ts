import { catalogItem } from "../catalog.js";
import { quoteView } from "../quotes/view.js";
import { nowS, type Services } from "../services.js";
import { addressUrl, esc, footer, header, isoMinute, notFoundPage, page, shortHex } from "./html.js";
import { previewPageUrl, watchUrl } from "./links.js";

// GET /q/{quote_id}: the watermarked preview before paying (autoplay muted loop) with price, deadline, escrow and how
// to buy. Built only from the public quote view (GET /v1/quotes/{id}), so it shows nothing that view does not.

const STATUS: Record<string, [string, string, string]> = {
  draft: ["sealed", "RENDERING", "The preview is rendering."],
  final: ["sealed", "READY TO BUY", "Watch it before you pay."],
  paid: ["published", "PAID", "This quote is paid."],
  expired: ["returned", "EXPIRED", "This quote expired."],
  cancelled: ["bad", "CANCELLED", "This quote was cancelled."],
};

export async function previewPage(s: Services, quoteId: string): Promise<Response> {
  const q = await s.repo.getQuote(quoteId);
  if (!q) return notFoundPage(s.cfg, "Quote");
  const v = quoteView(q, s.cfg, nowS(s));
  const title = catalogItem(q.catalog_id)?.title ?? q.format;
  const what = `${title} · ${v.spec.durationS} s · ${v.spec.aspect}`;
  const [cls, badge, headline] = STATUS[v.status] ?? ["bad", v.status.toUpperCase(), "Unknown state."];
  const instant = v.tier === "instant";
  const still = v.preview.still_url;
  const video = v.preview.video_url;

  const media = video
    ? `<video src="${esc(video)}"${still ? ` poster="${esc(still)}"` : ""} autoplay muted loop playsinline preload="auto"></video>`
    : still
      ? `<img src="${esc(still)}" alt="Key frame of the quoted clip (watermarked)">`
      : "";
  const lede =
    v.status === "draft"
      ? "Keyframe is rendering the key frame and the watermarked preview. This page refreshes by itself."
      : v.status === "paid"
        ? "Paid. The clean file opens on the order page once its key is published on Base."
        : v.status !== "final"
          ? "This quote can no longer be paid. Ask for a new quote in chat."
          : instant
            ? "This is the watermarked preview of the exact file you would buy: the clean file is already rendered and sealed, and its fingerprint is part of the deal. Paying releases its key."
            : "A hand-made Studio commission: you review the delivery before the studio is paid.";

  const rows: [string, string][] = [
    ["Price", `${esc(v.price.usdc)} USDC`],
    ["Clip", esc(what)],
    [
      instant ? "Delivered" : "Delivery by",
      instant
        ? `seconds after payment; the key must be on Base by ${esc(isoMinute(v.deadline))} or the money can only return to you`
        : `${esc(isoMinute(v.deadline))}, or the money can only return to you`,
    ],
    ...(v.status === "final"
      ? ([["Quote valid until", esc(isoMinute(v.quote_expires_at))]] as [string, string][])
      : []),
    [
      "Escrow",
      `<a href="${esc(addressUrl(v.escrow))}" target="_blank" rel="noopener noreferrer">${esc(shortHex(v.escrow))}</a> on Base`,
    ],
    ["Delivery", v.delivery === "public" ? "public (anyone with the order link can watch)" : "private (only you)"],
    ...(v.content.manifest_hash
      ? ([["Sealed file", `<span class="mono">${esc(shortHex(v.content.manifest_hash))}</span>`]] as [string, string][])
      : []),
  ];
  const buy =
    v.status === "final" && v.payable
      ? `<section class="card"><h2>How to buy</h2><ol class="steps">
<li><div><b>In a PayBox chat</b><br><span class="muted">With the Keyframe plugin enabled, ask your agent to buy quote <span class="mono">${esc(v.quote_id)}</span>. You approve one payment.</span></div></li>
<li><div><b>Any x402 client</b><br><span class="muted">Pay <span class="mono">${esc(v.order_url)}</span> (HTTP 402, ${esc(v.price.usdc)} USDC on Base) from the quoted wallet. See <a href="/llms.txt">llms.txt</a>.</span></div></li>
</ol></section>`
      : v.status === "paid" && v.order_id
        ? `<div class="actions"><a class="btn" href="${esc(watchUrl(s.cfg, v.order_id))}">Open the order</a></div>`
        : "";

  const body = `<main>
${header(esc(v.quote_id))}
<section>
<span class="badge ${cls}">${esc(badge)}</span>
<h1>${esc(headline)}</h1>
<p class="lede">${esc(lede)}</p>
</section>
${media ? `<section class="player">${media}<p class="muted small">Watermarked preview.</p></section>` : ""}
${buy}
<section class="card"><h2>The deal</h2><dl class="kv">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join("")}</dl></section>
${footer(`<p>Pay-on-delivery: your USDC waits at the escrow address and can reach the studio only when the key to your file is published on Base before the deadline; otherwise it can only return to you.</p>`)}
</main>`;
  return page(s.cfg, {
    title: `${what} · Keyframe preview`,
    description: `${what} for ${v.price.usdc} USDC. Watch the watermarked preview, then pay on delivery.`,
    meta: {
      "og:title": `${what} · ${v.price.usdc} USDC`,
      "og:description": "Watch the watermarked preview. Pay-on-delivery escrow on Base.",
      "og:type": video ? "video.other" : "website",
      "og:url": previewPageUrl(s.cfg, v.quote_id),
      "og:image": still,
      "og:video": video,
      "og:video:type": video ? "video/mp4" : null,
      "twitter:card": still ? "summary_large_image" : "summary",
    },
    body,
    cache: "no-store",
    ...(v.status === "draft" ? { refreshS: 5 } : {}),
  });
}
