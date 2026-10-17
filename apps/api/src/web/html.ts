import type { Config } from "../config.js";

// Shell for the human pages (/, /w/{order_id}, /q/{quote_id}): static HTML, system fonts, no external assets, and a
// strict CSP whose only inline style and (static) inline module are allowed by their sha256. Per-page data reaches
// the script as a JSON data block, which CSP never executes.

/** Public Base RPCs the watch page reads the key from (both send CORS headers for any origin). */
export const BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const;
export const EXPLORER = "https://basescan.org";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escapes text and attribute values. */
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export const shortHex = (h: string) => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
export const isoMinute = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
export const txUrl = (tx: string) => `${EXPLORER}/tx/${tx}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='3.5' y='3.5' width='9' height='9' rx='1.5' transform='rotate(45 8 8)' fill='%23e9c46a'/%3E%3C/svg%3E";

export const STYLE = `
:root{color-scheme:dark;--bg:#0c0c0e;--panel:#141417;--panel2:#1c1c20;--line:#2a2a30;--text:#f2f1ed;--muted:#a3a2a9;--faint:#706f77;--gold:#e9c46a;--green:#74d6a4;--red:#ff7d70;--blue:#93b9ff;--r:14px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:underline;text-decoration-color:#4a4a52;text-underline-offset:3px}
a:hover{text-decoration-color:var(--gold)}
main{max-width:680px;margin:0 auto;padding:20px 16px 56px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:28px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;text-decoration:none}
.brand i{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--gold);transform:rotate(45deg)}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:13px}
.mono{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
h1{font-size:clamp(27px,6.4vw,38px);line-height:1.12;letter-spacing:-.015em;margin:14px 0 10px;font-weight:700}
h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
p{margin:0 0 12px}
.lede{font-size:17px;color:var(--muted);max-width:56ch}
.badge{display:inline-flex;align-items:center;gap:8px;font:600 12px/1 var(--mono);letter-spacing:.14em;padding:7px 11px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.badge.sealed{color:var(--gold);border-color:#4d4124}.badge.published{color:var(--green);border-color:#25503a}
.badge.returned{color:var(--blue);border-color:#2b3c5c}.badge.bad{color:var(--red);border-color:#5c2b27}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px;margin:16px 0}
.player{margin:22px 0 6px}
.player video,.player img{display:block;width:100%;height:auto;max-height:76vh;margin:0 auto;background:#000;border-radius:var(--r);border:1px solid var(--line);object-fit:contain}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 20px;border-radius:12px;background:var(--gold);color:#18150b;font-family:inherit;font-size:16px;font-weight:650;line-height:1;text-decoration:none;border:0;cursor:pointer}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.bar{height:6px;background:var(--panel2);border-radius:99px;overflow:hidden;margin-top:18px}
.bar i{display:block;height:100%;width:0;background:var(--gold);transition:width .2s ease}
.checks{list-style:none;margin:0;padding:0}
.checks li{display:grid;grid-template-columns:22px 1fr;gap:10px;padding:11px 0;border-top:1px solid var(--line)}
.checks li:first-child{border-top:0;padding-top:2px}
.checks .mark{font:700 14px/22px var(--mono);text-align:center;color:var(--faint)}
.checks .ok .mark{color:var(--green)}.checks .fail .mark{color:var(--red)}.checks .wait .mark{color:var(--gold)}
.checks b{display:block;font-weight:600}
.checks span{color:var(--muted);font-size:14px}
.kv{display:grid;grid-template-columns:minmax(104px,34%) 1fr;gap:9px 14px;margin:0}
.kv dt{color:var(--muted);font-size:14px}
.kv dd{margin:0;font-size:14px;overflow-wrap:anywhere}
.kv+p:not(:empty){margin:16px 0 0;padding-top:12px;border-top:1px solid var(--line)}
.steps{counter-reset:s;list-style:none;margin:0;padding:0;display:grid;gap:12px}
.steps li{counter-increment:s;display:grid;grid-template-columns:30px 1fr;gap:12px}
.steps li::before{content:counter(s);font:700 13px/30px var(--mono);text-align:center;width:30px;height:30px;border-radius:50%;border:1px solid var(--line);color:var(--gold)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.stats div{background:var(--panel2);border-radius:12px;padding:12px 14px}
.stats b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.stats span{color:var(--muted);font-size:13px}
.stats+p{margin:14px 0 0}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:0;padding-top:0}
.list .r{flex:none;text-align:right}
.tag{font:600 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.tag.on{color:var(--green)}
footer{margin-top:36px;color:var(--faint);font-size:13px}
footer a{color:var(--muted)}
[hidden]{display:none!important}
`;

const hashes = new Map<string, Promise<string>>();
/** CSP source for an inline element's exact text: 'sha256-<base64>'. */
export function cspHash(text: string): Promise<string> {
  let h = hashes.get(text);
  if (!h) {
    h = crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((d) => {
      let bin = "";
      for (const b of new Uint8Array(d)) bin += String.fromCharCode(b);
      return `'sha256-${btoa(bin)}'`;
    });
    hashes.set(text, h);
  }
  return h;
}

export interface PageOptions {
  title: string;
  description: string;
  /** Trusted HTML: every interpolated value already passed through esc(). */
  body: string;
  /** Static inline module (allowed by hash). */
  script?: string;
  /** JSON for the script, as <script type="application/json" id="kf-data">. */
  data?: unknown;
  /** Extra <meta property=…> tags (og:*, twitter:*), values escaped here. */
  meta?: Record<string, string | null | undefined>;
  /** Origins the script may fetch from besides 'self'. */
  connect?: readonly string[];
  status?: number;
  cache?: string;
  /** <meta http-equiv="refresh"> seconds (pages without a script that wait for a state change). */
  refreshS?: number;
}

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export async function page(cfg: Config, o: PageOptions): Promise<Response> {
  const files = origin(cfg.filesBaseUrl);
  const extFiles = files && files !== origin(cfg.publicBaseUrl) ? ` ${files}` : "";
  const csp = [
    "default-src 'none'",
    `script-src ${o.script ? await cspHash(o.script) : "'none'"}`,
    `style-src ${await cspHash(STYLE)}`,
    `img-src 'self' data: blob:${extFiles}`,
    `media-src 'self' blob:${extFiles}`,
    `connect-src 'self'${extFiles}${(o.connect ?? []).map((c) => ` ${c}`).join("")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const meta = Object.entries(o.meta ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `<meta ${k.startsWith("twitter:") ? "name" : "property"}="${esc(k)}" content="${esc(v)}">`)
    .join("\n");
  // JSON inside <script>: "<" escaped so no value can close the element.
  const data =
    o.data === undefined
      ? ""
      : `<script type="application/json" id="kf-data">${JSON.stringify(o.data).replace(/</g, "\\u003c")}</script>\n`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0c0c0e">
${o.refreshS ? `<meta http-equiv="refresh" content="${o.refreshS}">\n` : ""}<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
${meta}
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body>
${o.body}
${data}${o.script ? `<script type="module">${o.script}</script>\n` : ""}</body>
</html>
`;
  return new Response(html, {
    status: o.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Cache-Control": o.cache ?? "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export const header = (right = "") =>
  `<header class="top"><a class="brand" href="/"><i></i>Keyframe</a>${right ? `<span class="faint mono">${right}</span>` : ""}</header>`;

export const footer = (extra = "") =>
  `<footer>${extra}<p><a href="/">Keyframe</a> · <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">API</a> · <a href="/health">status</a> · <a href="https://github.com/OoJae/keyframe">source</a> · Contracts are unaudited; every order is capped at 50 USDC.</p></footer>`;

/** HTML 404 for the human pages (the JSON API keeps its JSON 404s). */
export function notFoundPage(cfg: Config, what: string): Promise<Response> {
  return page(cfg, {
    title: "Not found · Keyframe",
    description: `${what} not found`,
    status: 404,
    body: `<main>${header()}<span class="badge bad">NOT FOUND</span><h1>${esc(what)} not found</h1><p class="lede">Check the link from your chat. Order links start with /w/o_ and preview links with /q/q_.</p>${footer()}</main>`,
  });
}
