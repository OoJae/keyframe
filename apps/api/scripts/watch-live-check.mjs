// Read-only check of the watch page's decrypt core against a live order: GET the order view, eth_call
// factory.order(termsHash) on two public Base RPCs, GET the manifest and chunks, then open them with exactly the
// code /w/{order_id} ships (src/web/open-core.ts) and compare the plaintext sha256 with the manifest.
// GETs and eth_calls only: nothing is written, signed or sent.
//
// Usage (Node 24 strips the .ts types): node scripts/watch-live-check.mjs [order_id] [api_base] [k_buyer]

import { OPEN_CORE_EXPORTS, OPEN_CORE_JS } from "../src/web/open-core.ts";

const orderId = process.argv[2] ?? "o_YF8xCvJy3fusQUQzaJCMjG";
const api = (process.argv[3] ?? "https://keyframe-api.keyframe-spike-server.workers.dev").replace(/\/+$/, "");
const kBuyerArg = process.argv[4];
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];

const core = new Function(`"use strict";\n${OPEN_CORE_JS}\nreturn { ${OPEN_CORE_EXPORTS.join(", ")} };`)();

const res = await fetch(`${api}/v1/orders/${orderId}`, { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`order view: HTTP ${res.status}`);
const view = await res.json();
console.log(`order ${view.order_id}: ${view.status} (${view.delivery}), manifest ${view.manifest_hash}`);

const chain = await core.readKeyFromBase(RPCS, view.factory, view.terms_hash);
for (const r of chain.readings)
  console.log(
    `  ${r.rpc}: ${r.view ? `status ${r.view.status}, key ${r.view.key.slice(0, 10)}…` : `error ${r.error}`}`,
  );
console.log(`key read on ${chain.answered}/${chain.asked} RPCs, agree: ${chain.agree}`);
if (chain.view.status !== core.STATUS_RELEASED || chain.view.key === core.ZERO32) throw new Error("key not published");
if (chain.view.manifestHash !== view.manifest_hash.toLowerCase()) throw new Error("manifest hash on Base differs");

const kBuyer = view.delivery === "public" ? core.ZERO32 : (view.k_buyer ?? kBuyerArg);
if (!kBuyer) throw new Error("private order: pass k_buyer as the third argument");
const started = Date.now();
const opened = await core.openFromStorage({
  filesBase: view.manifest_url.slice(0, view.manifest_url.indexOf("/c/")),
  manifestHash: chain.view.manifestHash,
  kChain: chain.view.key,
  kBuyer,
  salt: view.terms?.salt,
  onStep: (name, d) => name === "chunk" && console.log(`  chunk ${d.done}/${d.total} verified and opened`),
});
const m = opened.manifest;
console.log(
  `opened ${opened.plaintext.byteLength} bytes (${m.media.mime} ${m.media.width}x${m.media.height}, ${m.media.durationMs} ms) in ${Date.now() - started} ms`,
);
console.log(`plaintext sha256 ${opened.sha256}`);
console.log(`manifest  sha256 ${m.plaintextSha256}`);
console.log(opened.sha256 === m.plaintextSha256.toLowerCase() ? "MATCH" : "MISMATCH");
if (opened.sha256 !== m.plaintextSha256.toLowerCase()) process.exit(1);
