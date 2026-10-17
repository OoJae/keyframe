import type { Spec } from "@keyframe/protocol";
import { catalogItem, formatUsdc } from "../catalog.js";
import type { OrderRow } from "../db/rows.js";
import type { Services } from "../services.js";
import { addressUrl, BASE_RPCS, EXPLORER, esc, footer, header, notFoundPage, page, shortHex, txUrl } from "./html.js";
import { watchUrl } from "./links.js";
import { OPEN_CORE_JS } from "./open-core.js";

// GET /w/{order_id}: watch & download. The page fetches the order view (with `Authorization: Bearer <t>` when the
// URL fragment carries #t=), reads K_chain from factory.order(termsHash) on two public Base RPCs, downloads the KFC1
// manifest and chunks, checks every hash, decrypts in the browser and plays the file from a Blob URL. Fragments
// (#t=, #kb=) are read by the script only: never sent in a URL, never to Keyframe except the token as a header.

/** Badge class, badge, headline, lede per order status (sealed-envelope language). */
export const ORDER_STATES: Record<OrderRow["status"], [string, string, string, string]> = {
  funding: [
    "sealed",
    "PAYMENT ARRIVING",
    "Your payment is on its way to the escrow.",
    "Base has not confirmed it yet. Nothing to do: this page updates by itself.",
  ],
  sealed: [
    "sealed",
    "SEALED",
    "Your money is sealed in escrow.",
    "It can reach the studio only when the key to your file is published on Base before the deadline; otherwise it can only return to you. This page opens the file as soon as the key lands.",
  ],
  delivered: [
    "sealed",
    "SEALED · IN REVIEW",
    "Delivered. Waiting for your review.",
    "Accept or ask for changes from your chat. The money stays sealed until the key is published.",
  ],
  key_published: [
    "published",
    "KEY PUBLISHED",
    "The key to your file is on Base.",
    "This page reads the key from Base, opens the sealed file here in your browser and checks every fingerprint.",
  ],
  returned: ["returned", "RETURNED", "The money went back.", "The escrow returned the USDC to the buyer's wallet."],
  void: [
    "returned",
    "RETURNED",
    "Cancelled and refunded.",
    "Everything the escrow held went back to the buyer's wallet.",
  ],
  failed: ["bad", "NOT FUNDED", "The payment did not complete.", "No money moved for this order."],
};

export const LICENSE_LINE =
  "License: yours to post and use, including in ads and paid promotion. The template design itself stays Keyframe's.";

/** The page's UI (runs after OPEN_CORE_JS in the same module scope; DOM only through textContent). */
export const WATCH_UI_JS = String.raw`
const DATA = JSON.parse(document.getElementById("kf-data").textContent);
const $ = (id) => document.getElementById(id);
const FRAGMENT = new URLSearchParams(location.hash.slice(1));
const ACCESS = FRAGMENT.get("t");
const KB = FRAGMENT.get("kb");
const LIVE = ["funding", "sealed", "delivered"];
const FAIL = {
  manifest_hash: "Sealed file does not match Base",
  manifest_shape: "Sealed file is malformed",
  salt_mismatch: "Sealed file belongs to another deal",
  chunk_hash: "A piece was altered",
  chunk_length: "A piece was altered",
  chunk_auth: "A piece did not open with the key",
  plaintext_hash: "Opened file does not match its fingerprint",
  fetch: "Could not download the sealed file",
  too_large: "Too large for this browser",
};
let timer = 0;
let objectUrl = null;
let busy = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function show(id, on) {
  $(id).hidden = !on;
}
function short(h) {
  return typeof h === "string" && h.length > 18 ? h.slice(0, 10) + "…" + h.slice(-6) : h;
}
function link(href, text) {
  const a = el("a", null, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function txLink(tx, text) {
  return typeof tx === "string" && B32_RE.test(tx) && !/^0x0+$/.test(tx) ? link(DATA.explorer + "/tx/" + tx, text) : null;
}
function usdc(atomic) {
  try {
    const v = BigInt(atomic);
    const frac = (v % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return (v / 1000000n).toString() + "." + frac.padEnd(2, "0") + " USDC";
  } catch {
    return "—";
  }
}
function when(unix) {
  return unix ? new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
}
function mb(bytes) {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1) + " MB";
}
function setState(status, override) {
  const s = override || DATA.states[status] || ["bad", String(status).toUpperCase(), "Unknown state.", ""];
  $("badge").className = "badge " + s[0];
  $("badge").textContent = s[1];
  $("headline").textContent = s[2];
  $("lede").textContent = s[3];
}
function progress(frac, text) {
  $("bar").style.width = Math.round(frac * 100) + "%";
  $("progress-text").textContent = text;
}

const rows = new Map();
function check(id, state, title, detail, a) {
  let li = rows.get(id);
  if (!li) {
    li = el("li");
    rows.set(id, li);
    $("checks").appendChild(li);
  }
  li.className = state;
  li.textContent = "";
  li.appendChild(el("span", "mark", state === "ok" ? "✓" : state === "fail" ? "✕" : "…"));
  const box = el("div");
  box.appendChild(el("b", null, title));
  if (detail || a) {
    const s = el("span", null, detail ? detail + " " : "");
    if (a) s.appendChild(a);
    box.appendChild(s);
  }
  li.appendChild(box);
}
function dropChecks(ids) {
  for (const id of ids || Array.from(rows.keys())) {
    if (rows.has(id)) rows.get(id).remove();
    rows.delete(id);
  }
}

function receipt(v, cv) {
  const dl = $("receipt-list");
  dl.textContent = "";
  const row = (k, parts) => {
    const vals = parts.filter(Boolean);
    if (vals.length === 0) return;
    dl.appendChild(el("dt", null, k));
    const dd = el("dd");
    vals.forEach((p, i) => {
      if (i) dd.append(" · ");
      dd.append(p);
    });
    dl.appendChild(dd);
  };
  const s = v.spec;
  row("Order", [el("span", "mono", v.order_id)]);
  row("Item", [s ? DATA.title + " · " + s.durationS + " s · " + s.aspect : DATA.title]);
  row("Price", [usdc(v.amount)]);
  const paid = (v.timeline || []).find((e) => e.event === "paid");
  row("Paid", [paid && when(paid.at), txLink(v.funding_tx, "funding tx")]);
  if (v.status === "key_published") {
    row("Key published", [cv ? when(cv.finalAt) : null, txLink(v.release_tx, "release tx")]);
  }
  if (v.status === "returned" || v.status === "void") {
    row("Returned", [txLink(v.refund_tx || v.cancel_tx || v.decision_tx, "refund tx")]);
  }
  if (v.to_seller !== null && v.to_seller !== undefined) row("To the studio", [usdc(v.to_seller)]);
  if (v.to_buyer && v.to_buyer !== "0") row("Back to the buyer", [usdc(v.to_buyer)]);
  row("Escrow", [link(DATA.explorer + "/address/" + v.escrow, short(v.escrow))]);
  row("Deal", [el("span", "mono", short(v.terms_hash))]);
  $("license").textContent = v.status === "key_published" ? DATA.license : "";
}

function stateChecks(v) {
  dropChecks();
  if (v.status === "funding") {
    check("pay", "wait", "Payment arriving", "Waiting for Base to confirm it.", txLink(v.funding_tx, "funding tx"));
    return;
  }
  if (v.status === "failed") {
    check("pay", "fail", "Payment did not complete", "No money moved.");
    return;
  }
  check(
    "pay",
    "ok",
    "Money sealed in escrow",
    usdc(v.amount) + " sits at the escrow address, which can pay the studio only after the key is published.",
    txLink(v.funding_tx, "funding tx"),
  );
  if (v.status === "delivered") {
    check("dlv", "ok", "Delivered for review", "The key is published when you accept.", txLink(v.deliver_tx, "delivery tx"));
  }
  if (v.status === "sealed" || v.status === "delivered") {
    check(
      "key",
      "wait",
      "Key not published yet",
      v.status === "sealed" && v.deadline
        ? "Due by " + when(v.deadline) + ". If it is not published in time, the escrow can only return the money."
        : "This page opens the file as soon as it is.",
    );
  }
  if (v.status === "returned" || v.status === "void") {
    check(
      "back",
      "ok",
      "Money returned",
      "The escrow paid " + (v.to_buyer ? usdc(v.to_buyer) : "the money") + " back to the buyer.",
      txLink(v.refund_tx || v.cancel_tx || v.decision_tx, "refund tx"),
    );
  }
}

async function loadView() {
  const headers = { accept: "application/json" };
  if (ACCESS) headers.authorization = "Bearer " + ACCESS;
  let res;
  try {
    res = await fetch(DATA.api, { headers, credentials: "omit", cache: "no-store" });
  } catch {
    throw new Error("Could not reach Keyframe. Check your connection and try again.");
  }
  if (res.status === 401) throw new Error("This access link is not valid for this order.");
  if (res.status === 404) throw new Error("Keyframe does not know this order.");
  if (!res.ok) throw new Error("Keyframe answered HTTP " + res.status + ". Try again in a moment.");
  return res.json();
}

async function refresh() {
  clearTimeout(timer);
  show("retry", false);
  let v;
  try {
    v = await loadView();
  } catch (e) {
    setState(null, ["bad", "UNAVAILABLE", "Could not load this order.", e.message]);
    show("retry", true);
    return;
  }
  setState(v.status);
  receipt(v, null);
  if (v.status === "key_published") return openOrder(v);
  stateChecks(v);
  if (LIVE.indexOf(v.status) >= 0) timer = setTimeout(refresh, Math.min(Math.max(v.poll_after_s || 10, 5), 30) * 1000);
}

async function openOrder(v) {
  dropChecks();
  let kBuyer = ZERO32;
  if (v.delivery === "private") {
    kBuyer = v.k_buyer || (KB && B32_RE.test(KB) ? KB.toLowerCase() : null);
    if (!kBuyer) {
      setState(null, [
        "sealed",
        "KEY PUBLISHED · PRIVATE",
        "This file is private.",
        "Only the buyer can open it, with the watch link their agent gives them: it ends in #kb=…, a key part that never leaves this device.",
      ]);
      check("kb", "wait", "Your key part is needed", "Ask your agent for this order's watch link with your k_buyer.");
      return;
    }
  }
  check("base", "wait", "Reading the key from Base", "Asking two independent Base RPCs…");
  let chain;
  try {
    chain = await readKeyFromBase(DATA.rpcs, v.factory || DATA.factory, v.terms_hash);
  } catch (e) {
    check("base", "fail", "Could not read the key from Base", e.message + ".");
    show("retry", true);
    return;
  }
  const cv = chain.view;
  if (cv.status !== STATUS_RELEASED || cv.key === ZERO32) {
    check("base", "wait", "Waiting for Base", "The RPCs do not show the published key yet; they can lag a few seconds.");
    timer = setTimeout(refresh, 6000);
    return;
  }
  receipt(v, cv);
  check(
    "base",
    "ok",
    "Key published on Base",
    chain.agree
      ? "Read from " + chain.answered + " independent Base RPCs, which agree."
      : "Read from " + chain.answered + " of " + chain.asked + " Base RPCs.",
    txLink(v.release_tx, "release tx"),
  );
  if (v.manifest_hash && v.manifest_hash.toLowerCase() !== cv.manifestHash) {
    check("sealed", "fail", "Keyframe's record differs from Base", "The fingerprint Keyframe reports is not the one on Base, so nothing is opened.");
    return;
  }
  const committed = !!(v.terms && String(v.terms.contentHash).toLowerCase() === cv.manifestHash);
  // Studio: after a change request only an explicit accept releases, so a revision is the accepted file.
  const rev = v.changes && v.changes.revision && v.changes.revision.manifest_hash;
  const files = [];
  if (typeof rev === "string" && B32_RE.test(rev) && rev.toLowerCase() !== cv.manifestHash) {
    files.push({ mh: rev.toLowerCase(), label: "revised version", onChain: false });
  }
  files.push({ mh: cv.manifestHash, label: files.length ? "first delivery" : "file", onChain: true });
  const alt = $("alt");
  if (files.length > 1) {
    let i = 0;
    alt.textContent = "Open the " + files[1].label;
    alt.onclick = () => {
      if (busy) return;
      i = 1 - i;
      alt.textContent = "Open the " + files[1 - i].label;
      openOne(v, cv, kBuyer, files[i], committed);
    };
    show("alt", true);
  }
  await openOne(v, cv, kBuyer, files[0], committed);
}

async function openOne(v, cv, kBuyer, file, committed) {
  busy = true;
  dropChecks(["sealed", "pieces", "file"]);
  show("player", false);
  show("progress", true);
  progress(0, "Downloading the sealed file…");
  let stage = "sealed";
  check("sealed", "wait", "Checking the sealed file", "Downloading its manifest…");
  try {
    const out = await openFromStorage({
      filesBase: DATA.files_base,
      manifestHash: file.mh,
      kChain: cv.key,
      kBuyer,
      salt: v.terms ? v.terms.salt : undefined,
      onStep(name, d) {
        if (name === "manifest") {
          stage = "pieces";
          check(
            "sealed",
            "ok",
            file.onChain ? "Sealed file matches Base" : "Revised file matches Keyframe's record",
            file.onChain
              ? "Its manifest hashes to the fingerprint the escrow recorded on Base" +
                  (committed ? ": the exact file committed in the deal before payment." : ".")
              : "Its manifest hashes to the revision fingerprint Keyframe published (Base records the first delivery).",
          );
          check("pieces", "wait", "Opening it with the key", "0 of " + d.manifest.chunks + " encrypted pieces");
        } else if (name === "chunk") {
          progress(d.done / d.total, "Opened " + d.done + " of " + d.total + (d.total === 1 ? " piece" : " pieces"));
          const all = d.done === d.total;
          check(
            "pieces",
            all ? "ok" : "wait",
            all ? "Every piece intact" : "Opening it with the key",
            d.done + " of " + d.total + " encrypted pieces match their fingerprints and opened with the published key.",
          );
          if (all) stage = "file";
        } else if (name === "file") {
          check("file", "ok", "Same file, byte for byte", "The opened file matches its original fingerprint " + short(d.sha256) + ".");
        }
      },
    });
    play(v, out, file);
    setState(null, [
      "published",
      "KEY PUBLISHED",
      file.onChain && file.label === "file" ? "Your file is ready." : "The " + file.label + " is ready.",
      "Opened in this browser with the key from Base and checked against every fingerprint. Download it to keep it.",
    ]);
  } catch (e) {
    show("progress", false);
    const code = e && e.code;
    check(stage, "fail", FAIL[code] || "Could not open the file", ((e && e.message) || String(e)) + ". Nothing unverified is shown.");
    if (code === "fetch") show("retry", true);
  } finally {
    busy = false;
  }
}

function play(v, out, file) {
  const m = out.manifest;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([out.plaintext], { type: m.media.mime || "video/mp4" }));
  const video = $("video");
  const w = m.media.width;
  const h = m.media.height;
  if (w && h) {
    video.style.aspectRatio = w + " / " + h;
    video.style.maxWidth = "calc(76vh * " + (w / h).toFixed(4) + ")";
  }
  // Show the deal's key frame until the first play (then start from 0): a still from the clean file, not a poster.
  const hero = file.onChain && v.spec && v.spec.keyframe ? v.spec.keyframe.atMs / 1000 : 0;
  if (hero > 0) {
    video.addEventListener("loadeddata", () => (video.currentTime = hero), { once: true });
    video.addEventListener(
      "play",
      () => {
        if (Math.abs(video.currentTime - hero) < 0.05) video.currentTime = 0;
      },
      { once: true },
    );
  }
  video.src = objectUrl;
  const a = $("download");
  a.href = objectUrl;
  a.download = "keyframe-" + v.order_id + (file.onChain ? "" : "-revision") + ".mp4";
  const secs = (m.media.durationMs / 1000).toFixed(1).replace(/\.0$/, "");
  $("filemeta").textContent = [w + "×" + h, secs + " s", mb(m.size)].join(" · ");
  show("progress", false);
  show("player", true);
}

$("retry-btn").addEventListener("click", () => refresh());
window.addEventListener("hashchange", () => location.reload());
refresh();
`;

/** The page's single inline module: the verification core, then the UI. */
export const WATCH_SCRIPT = `${OPEN_CORE_JS}\n${WATCH_UI_JS}`;

export async function watchPage(s: Services, orderId: string): Promise<Response> {
  const o = await s.repo.getOrder(orderId);
  const q = o ? await s.repo.getQuote(o.quote_id) : null;
  if (!o || !q) return notFoundPage(s.cfg, "Order");
  const title = catalogItem(q.catalog_id)?.title ?? q.format;
  const pub = q.delivery === "public";
  const spec = pub ? (JSON.parse(q.spec_json) as Spec) : null;
  const what = spec ? `${title} · ${spec.durationS} s · ${spec.aspect}` : title;
  const [cls, badge, headline, lede] = ORDER_STATES[o.status];
  const tx = (h: string | null, label: string) =>
    h && !/^0x0+$/.test(h)
      ? ` · <a href="${esc(txUrl(h))}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : "";
  // Server-rendered receipt basics (the script replaces them with live values, incl. the release time on Base).
  const receipt = [
    ["Order", `<span class="mono">${esc(o.id)}</span>`],
    ["Item", esc(what)],
    ["Price", `${esc(formatUsdc(BigInt(o.amount)))} USDC`],
    [
      "Paid",
      `${esc(new Date(o.created_at * 1000).toISOString().slice(0, 16).replace("T", " "))} UTC${tx(o.funding_tx, "funding tx")}`,
    ],
    ...(o.status === "key_published" ? [["Key published", `on Base${tx(o.release_tx, "release tx")}`]] : []),
    [
      "Escrow",
      `<a href="${esc(addressUrl(o.escrow))}" target="_blank" rel="noopener noreferrer">${esc(shortHex(o.escrow))}</a>`,
    ],
    ["Deal", `<span class="mono">${esc(shortHex(o.terms_hash))}</span>`],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");
  const body = `<main>
${header(esc(o.id))}
<section>
<span id="badge" class="badge ${cls}">${esc(badge)}</span>
<h1 id="headline">${esc(headline)}</h1>
<p id="lede" class="lede">${esc(lede)}</p>
</section>
<section id="player" class="player" hidden>
<video id="video" playsinline controls preload="auto"></video>
<div class="actions"><a id="download" class="btn" href="#">Download MP4</a><button id="alt" class="btn ghost" type="button" hidden></button><span id="filemeta" class="muted small"></span></div>
</section>
<section id="progress" hidden><div class="bar"><i id="bar"></i></div><p id="progress-text" class="muted small"></p></section>
<div id="retry" class="actions" hidden><button id="retry-btn" class="btn ghost" type="button">Try again</button></div>
<section class="card"><h2>Checks</h2><ol id="checks" class="checks"></ol><noscript><p class="muted small">This page opens and checks your file in the browser, so it needs JavaScript. In chat, keyframe_verify runs the same checks.</p></noscript></section>
<section class="card" id="receipt"><h2>Receipt</h2><dl id="receipt-list" class="kv">${receipt}</dl><p id="license" class="muted small">${o.status === "key_published" ? esc(LICENSE_LINE) : ""}</p></section>
${footer(`<p>The file opens in this browser: the key comes from Base, not from Keyframe's server, and every piece is checked against the fingerprints in the deal. In chat, keyframe_verify runs the same checks.</p>`)}
</main>`;
  return page(s.cfg, {
    title: `${what} · Keyframe order`,
    description: `Keyframe order ${o.id}: ${badge.toLowerCase()}. Pay-on-delivery motion clip; the key to the file is published on Base.`,
    meta: {
      "og:title": `${what} · Keyframe`,
      "og:description": `${headline} Pay-on-delivery motion, verified on Base.`,
      "og:type": "website",
      "og:url": watchUrl(s.cfg, o.id),
      "og:image": pub ? q.still_url : null,
      "twitter:card": pub && q.still_url ? "summary_large_image" : "summary",
    },
    connect: BASE_RPCS,
    data: {
      order_id: o.id,
      api: `/v1/orders/${o.id}`,
      factory: s.cfg.factory,
      rpcs: BASE_RPCS,
      files_base: s.cfg.filesBaseUrl,
      explorer: EXPLORER,
      title,
      states: ORDER_STATES,
      license: LICENSE_LINE,
    },
    script: WATCH_SCRIPT,
    body,
  });
}
