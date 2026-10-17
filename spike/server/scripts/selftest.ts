// Offline self-test for the spike server's pure pieces. Generates a throwaway mnemonic IN MEMORY (never printed or
// written) and checks that the server's WebCrypto/HDKey derivation equals viem's mnemonicToAccount for several indexes,
// that ids have the right shape, and that the v1 challenge is byte-stable.
//
//   pnpm exec tsx scripts/selftest.ts

import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";

import { deriveSpikePayee } from "../src/hd.js";
import { newOrderId, newQuoteId, ORDER_ID_RE, QUOTE_ID_RE } from "../src/ids.js";
import { v1PaymentRequiredBody } from "../src/x402.js";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

const mnemonic = generateMnemonic(english);
for (const i of [0, 1, 2, 7, 1000]) {
  const ours = await deriveSpikePayee(mnemonic, i);
  const viem = mnemonicToAccount(mnemonic, { addressIndex: i }).address;
  check(`index ${i}: server derivation == viem mnemonicToAccount (${ours})`, ours === viem);
}
// Extra whitespace in the stored secret must not change the derivation.
check("whitespace-normalised mnemonic derives the same index 0", (await deriveSpikePayee(`  ${mnemonic.split(" ").join("   ")}\n`, 0)) === mnemonicToAccount(mnemonic).address);

const ids = Array.from({ length: 200 }, () => newQuoteId());
check("200 quote ids match ^q_[base58]{22}$", ids.every((q) => QUOTE_ID_RE.test(q)));
check("200 quote ids are unique", new Set(ids).size === ids.length);
check("order id matches ^o_[base58]{22}$", ORDER_ID_RE.test(newOrderId()));

const quote = { quote_id: "q_11111111111111111111111", pay_to: "0x000000000000000000000000000000000000dEaD", pay_to_index: 0, amount: "100000", buyer: "0x1111111111111111111111111111111111111111", created_at: "2026-10-17T00:00:00.000Z" } as const;
const a = v1PaymentRequiredBody(quote, "https://x.example/v1/orders/q_11111111111111111111111");
const b = v1PaymentRequiredBody(quote, "https://x.example/v1/orders/q_11111111111111111111111");
check("v1 challenge body is byte-stable", a === b);

process.exitCode = failures ? 1 : 0;
