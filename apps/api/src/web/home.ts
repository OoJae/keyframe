import { CATALOG, formatUsdc } from "../catalog.js";
import type { Services } from "../services.js";
import { addressUrl, esc, footer, header, page } from "./html.js";
import { watchUrl } from "./links.js";

// GET /: the front door. What Keyframe is, how the buyer is protected, how to order, live counters (/v1/stats) and
// what can be ordered today. Only what is live: formats that are not sellable are listed as "coming soon".

/** The first mainnet order (public delivery), linked as a worked example while it exists in this deployment. */
export const EXAMPLE_ORDER_ID = "o_YF8xCvJy3fusQUQzaJCMjG";

const usdcOf = (atomic: unknown) => formatUsdc(BigInt(typeof atomic === "string" ? atomic : String(atomic ?? 0)));

function eta(seconds: number): string {
  if (seconds < 120) return `~${seconds} s`;
  if (seconds < 7200) return `~${Math.round(seconds / 60)} min`;
  return `within ${Math.round(seconds / 3600)} h`;
}

export async function homePage(s: Services): Promise<Response> {
  const stats = await s.repo.stats();
  const example = await s.repo.getOrder(EXAMPLE_ORDER_ID);
  const exampleQuote = example ? await s.repo.getQuote(example.quote_id) : null;
  const showExample = example?.status === "key_published" && exampleQuote?.delivery === "public";

  const items = CATALOG.filter((i) => !i.hidden);
  const live = items.filter((i) => i.renderable && !s.cfg.formatsDisabled.has(i.id));
  const soon = items.filter((i) => !live.includes(i));
  const price = (p: Readonly<Record<number, bigint>>) => {
    const v = Object.values(p);
    const min = v.reduce((a, b) => (b < a ? b : a), v[0] ?? 0n);
    return `${v.length > 1 ? "from " : ""}${formatUsdc(min)} USDC`;
  };
  const liveList = live
    .map(
      (i) =>
        `<li><div><b>${esc(i.title)}</b><br><span class="muted small">${esc(i.description)}</span></div><div class="r"><span class="tag on">${esc(i.tier === "studio" ? "hand-made" : "instant")}</span><br><span class="muted small">${esc(price(i.prices))}<br>${esc(eta(i.etaS))}</span></div></li>`,
    )
    .join("");
  const soonList = soon.map((i) => esc(i.title)).join(", ");

  const counters: [string, string][] = [
    [String(stats.orders ?? 0), "orders"],
    [String(stats.delivered ?? 0), "keys published"],
    [String(stats.returned ?? 0), "refunded"],
    [usdcOf(stats.paid_to_studio_atomic), "USDC paid on delivery"],
  ];

  const body = `<main>
${header()}
<section>
<span class="badge published">LIVE ON BASE</span>
<h1>Hire a motion designer from chat. Pay only on delivery.</h1>
<p class="lede">Keyframe makes short motion clips (launch countdowns, stings, Studio commissions) and seals your payment in an escrow on Base that pays the studio only when your file is delivered.</p>
</section>
<section class="card"><h2>How your money is protected</h2><ol class="steps">
<li><div><b>Ask</b><br><span class="muted">Describe the clip in chat and get an exact price. Instant clips are rendered first, so you watch a watermarked preview before you pay.</span></div></li>
<li><div><b>One tap</b><br><span class="muted">Your USDC goes to an escrow address derived from the deal. It can pay the studio only by publishing the key to your file on Base.</span></div></li>
<li><div><b>Your file, or your money back</b><br><span class="muted">The key opens your video. If it is not published by the deadline, the escrow can only return the money to you; anyone can trigger that refund.</span></div></li>
</ol></section>
<section class="card"><h2>Live</h2><div class="stats">${counters.map(([n, l]) => `<div><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("")}</div>
${showExample ? `<p class="small muted">Example: <a href="${esc(watchUrl(s.cfg, EXAMPLE_ORDER_ID))}">watch the first mainnet order</a>, opened in your browser with the key from Base.</p>` : ""}</section>
<section class="card"><h2>Order now</h2><ul class="list">${liveList || `<li><span class="muted">Nothing is open for orders right now.</span></li>`}</ul>
${soonList ? `<p class="small muted">Coming soon: ${soonList}.</p>` : ""}</section>
<section class="card"><h2>How to order</h2><ol class="steps">
<li><div><b>In PayBox chats</b><br><span class="muted">Enable the Keyframe plugin and ask for a clip. Your agent quotes it, shows the preview and asks you to approve one payment.</span></div></li>
<li><div><b>Any x402 client</b><br><span class="muted">Use the documented API: <a href="/llms.txt">llms.txt</a>, <a href="/openapi.json">OpenAPI</a>, <a href="/v1/styles">formats and prices</a>.</span></div></li>
</ol></section>
<section class="card"><h2>Good to know</h2><ul class="list">
<li><span class="muted">The escrow contracts are unaudited. Every order is capped at ${esc(formatUsdc(s.cfg.maxAmount))} USDC.</span></li>
<li><span class="muted">Public delivery (the default for most formats) means anyone with the order link can watch the file once its key is published. Choose private delivery to keep it to yourself.</span></li>
<li><span class="muted">Escrow factory: <a href="${esc(addressUrl(s.cfg.factory))}" target="_blank" rel="noopener noreferrer" class="mono">${esc(s.cfg.factory)}</a> (Base mainnet). Service status: <a href="/health">/health</a>.</span></li>
</ul></section>
${footer()}
</main>`;
  return page(s.cfg, {
    title: "Keyframe · Pay-on-delivery motion",
    description:
      "Hire a motion designer from chat and pay only on delivery: a USDC escrow on Base that pays only when the key to your file is published.",
    meta: {
      "og:title": "Keyframe · Pay-on-delivery motion",
      "og:description": "Hire a motion designer from chat. Pay only on delivery, escrowed on Base.",
      "og:type": "website",
      "og:url": `${s.cfg.publicBaseUrl}/`,
    },
    body,
    cache: "public, max-age=30",
  });
}
