// Paid-path probe without money: signs a REAL EIP-3009 x402 payment for the order's 402 with an ephemeral,
// unfunded key generated in memory, sends it, and prints what the server answered. Expected outcome: the
// facilitator's verify rejects it (the payer has no USDC), the server answers 402 with an error, nothing settles.
//
//   pnpm exec tsx scripts/paid-probe.ts <order_url> [--header-host <host>]
//
// Uses the official @x402 client (spend cap default $1, so quotes above 1 USDC need a raised cap).

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const url = process.argv[2];
if (!url) {
  console.error("usage: tsx scripts/paid-probe.ts <order_url>");
  process.exit(1);
}

const account = privateKeyToAccount(generatePrivateKey()); // ephemeral, unfunded, never printed
const client = new x402Client();
registerExactEvmScheme(client, { signer: toClientEvmSigner(account) });
const http = new x402HTTPClient(client);

const unpaid = await fetch(url, { method: "POST" });
const bodyText = await unpaid.text();
let body: unknown = undefined;
try {
  body = JSON.parse(bodyText);
} catch {
  body = undefined;
}
console.log(`unpaid: HTTP ${unpaid.status}`);
const required = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), body);
const payload = await client.createPaymentPayload(required);
const headers = http.encodePaymentSignatureHeader(payload);
const headerName = Object.keys(headers)[0];
const auth = (payload.payload as { authorization?: Record<string, string> }).authorization;
console.log(`signed x402 v${payload.x402Version} payment (${headerName}) from ephemeral ${auth?.from} to ${auth?.to} value ${auth?.value}`);

const paid = await fetch(url, { method: "POST", headers });
const paidText = await paid.text();
console.log(`paid attempt: HTTP ${paid.status}`);
const pr = paid.headers.get("payment-required");
if (pr) {
  const decoded = JSON.parse(Buffer.from(pr, "base64").toString("utf8")) as { error?: string };
  console.log(`PAYMENT-REQUIRED error field: ${decoded.error}`);
} else {
  console.log(`body: ${paidText.slice(0, 400)}`);
}
console.log(`PAYMENT-RESPONSE header present: ${paid.headers.has("payment-response") || paid.headers.has("x-payment-response")}`);
