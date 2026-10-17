// LOCAL TEST ONLY (pair with scripts/mock-facilitator.mjs): drives the spike server's paid path with real x402
// client payloads signed by an ephemeral, unfunded key generated in memory.
//
//   tsx scripts/paid-flow.ts full  <order_url> <mock_stats_url>   pay, replay same payment, pay again with a new nonce, unpaid probe
//   tsx scripts/paid-flow.ts abort <order_url> <mock_stats_url> <client_timeout_ms>   client gives up during PAID_DELAY_MS
//   tsx scripts/paid-flow.ts once  <order_url> <mock_stats_url>   one paid request, print the response
//   tsx scripts/paid-flow.ts raw   <order_url>                    one paid request, print only the raw 200 body (for diag_paid_echo)
//   tsx scripts/paid-flow.ts mangled <order_url> <mock_stats_url> echo `accepted` with a lowercased payTo and no extra

import { createHash } from "node:crypto";

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [mode, url, statsUrl, timeoutArg] = process.argv.slice(2);
if (!mode || !url) {
  console.error("usage: tsx scripts/paid-flow.ts full|abort|once|raw <order_url> [mock_stats_url] [timeout_ms]");
  process.exit(2);
}
const account = privateKeyToAccount(generatePrivateKey());
const client = new x402Client();
registerExactEvmScheme(client, { signer: toClientEvmSigner(account) });
const http = new x402HTTPClient(client);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stats = async () => (statsUrl ? ((await (await fetch(statsUrl)).json()) as { verify: number; settle: number }) : null);

async function challenge() {
  const unpaid = await fetch(url!, { method: "POST" });
  const text = await unpaid.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), body);
}

/** Each call signs a fresh EIP-3009 authorization (random nonce) for the given challenge. */
async function paymentHeaders(required: Awaited<ReturnType<typeof challenge>>): Promise<Record<string, string>> {
  return http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}

const newPaymentHeaders = async () => paymentHeaders(await challenge());

async function pay(headers: Record<string, string>, signal?: AbortSignal) {
  const res = await fetch(url!, { method: "POST", headers, signal });
  const text = await res.text();
  const pr = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  return { status: res.status, text, paymentResponse: pr ? JSON.parse(Buffer.from(pr, "base64").toString("utf8")) : null };
}

if (mode === "mangled") {
  const payload = await client.createPaymentPayload(await challenge());
  const accepted = { ...(payload.accepted as Record<string, unknown>) };
  accepted.payTo = String(accepted.payTo).toLowerCase();
  delete accepted.extra;
  const r = await pay(http.encodePaymentSignatureHeader({ ...payload, accepted } as typeof payload));
  console.log(`paid with mangled accepted (lowercase payTo, no extra): HTTP ${r.status} settlement_tx=${JSON.parse(r.text).settlement_tx ?? null}`);
  console.log(`facilitator calls: ${JSON.stringify(await stats())}`);
} else if (mode === "raw") {
  const r = await pay(await newPaymentHeaders());
  process.stdout.write(r.text);
} else if (mode === "once") {
  const r = await pay(await newPaymentHeaders());
  console.log(`paid: HTTP ${r.status} body=${r.text}`);
  console.log(`facilitator calls: ${JSON.stringify(await stats())}`);
} else if (mode === "abort") {
  const ms = Number(timeoutArg ?? 500);
  const headers = await newPaymentHeaders();
  const t0 = Date.now();
  try {
    await pay(headers, AbortSignal.timeout(ms));
    console.log("unexpected: request completed");
  } catch (e) {
    console.log(`client gave up after ${Date.now() - t0} ms (${(e as Error).name})`);
  }
  await new Promise((r) => setTimeout(r, 4_000)); // let the server's delay elapse
  console.log(`facilitator calls after the server's delay: ${JSON.stringify(await stats())}`);
} else if (mode === "full") {
  const before = await stats();
  const required = await challenge();
  const h1 = await paymentHeaders(required); // nonce A
  const h2 = await paymentHeaders(required); // nonce B, same terms
  const first = await pay(h1);
  console.log(`1 paid (nonce A):        HTTP ${first.status} body sha256=${sha(first.text)}`);
  console.log(`  body: ${first.text}`);
  console.log(`  PAYMENT-RESPONSE: ${JSON.stringify(first.paymentResponse)}`);
  const replay = await pay(h1);
  console.log(`2 replay (same nonce A): HTTP ${replay.status} body sha256=${sha(replay.text)} identical=${replay.text === first.text}`);
  const second = await pay(h2);
  console.log(`3 new payment (nonce B):  HTTP ${second.status} body=${second.text}`);
  const unpaid = await fetch(url, { method: "POST" });
  console.log(`4 unpaid probe after pay: HTTP ${unpaid.status} body=${await unpaid.text()}`);
  const after = await stats();
  console.log(`facilitator settle calls: before=${before?.settle} after=${after?.settle} (exactly one settlement expected)`);
}
