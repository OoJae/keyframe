# Live evidence: Base mainnet orders placed from Claude.ai

Real money, real chain. The buyer and studio wallets both belong to the builder (disclosed). Re-verify any row without
Keyframe's API: re-derive the escrow from the terms, read `factory.order(termsHash)` on Base, decrypt the file with the
published key (`keyframe_verify {mode:"delivery"}` does all of this).

## Order 1: Countdown, $1, Instant, public delivery (2026-10-17)

| Step | When (UTC) | Proof |
|---|---|---|
| Quote `q_xDHyoSjAfnEQ7vVCUvsQnK` created from Claude.ai (Manual mode) via `use_plugin` → `keyframe_quote` | 10:50:54 | worker log: job start |
| Watermarked still ready | 10:50:58 (3.9 s) | worker log: still uploaded |
| Final: encrypted master + preview, `contentHash` committed | 10:51:10 (15.6 s, render 6.7 s) | manifest `0x230eb84b…9947` |
| Buyer approves the x402 payment in the PayBox signing window (one tap, gasless) | ≈10:51:59 | PayBox card: "Payment sent" |
| **SEALED**: relayer calls `fundWithAuthorization` (EIP-3009 to the codeless escrow + register, one tx) | 10:52:01, block 52,722,487 | [`0xdc1e5f…cad77`](https://basescan.org/tx/0xdc1e5f4ac318bfd7faf603820f2ec4485aab3f9dd19188036ce5c26b371cad77), gas 218,278 |
| **KEY PUBLISHED**: `release` reveals the key on-chain; 1.00 USDC to the studio | 10:52:47, block 52,722,510 | [`0x9c1fbc…82e0`](https://basescan.org/tx/0x9c1fbc5eb3a8d4ecc27096600f6cabbb3e2114f6bcebfd24806163e88f1e82e0), gas 205,250 |
| Studio wallet `0xEB61…5f14` holds 1.00 USDC | 10:53 | `USDC.balanceOf` |

- Order `o_YF8xCvJy3fusQUQzaJCMjG`, terms hash `0x9e5a90c0075f70cb602dc5a9003ff71558a78e6b2e60ad918818db1128d2bf89`.
- Buyer: PayBox wallet "Keyframe Buyer" `0x1941B737fD7AF37344Ea86448EE9Ff66715F7995` (plain EOA, x402 rail).
- Escrow (CREATE2, had no code when paid): `0x4211C204530f7ed62f7be9616a520B6083A77033`.
- Factory `0xd9d55954366Bb9ce979B992DE7218DAF1d61e561`, operator/relayer `0xc1AF1dd7c4816a40aB69578E52CCbB4ddBFFda04`.

**Independent verification.** The uploaded bundle (`plugin/dist/plugin.mjs`, sha256 `de79e90e…1de05f`), run as a fresh
process against production, returned `VERIFIED · KEY PUBLISHED` in 3.1 s with 16/16 checks: factory allowlisted, terms
valid, content bound, terms hash and escrow address recomputed locally, 3 independent Base RPCs agree, escrow is a
Keyframe clone, deal registered, key published, `keccak256(key) == keyHash`, manifest hash == contentHash, manifest
matches, 1/1 chunk decrypted, file sha256 matches, MP4 header 1080x1920 8.0 s, matches the 9:16 brief.

**Friction observed (first payment from a new chat):**
- PayBox asked to connect a signing key for the wallet in its in-chat window before the first payment. The first quote
  (`q_Rfv4JaX1NGZAJfqXP34aTx`) expired while that happened; nothing was charged. A fresh quote took 16 s.
- Claude's reply text said the payment was still waiting while the PayBox card already showed "Payment sent";
  the chain was the source of truth.
- Claude.ai Auto mode's safety check blocked an order phrased with pasted instructions; a plain typed request in
  Manual mode went through.
- The API recorded the release about a minute after it was mined (the relayer's wait window had passed; the next
  status read confirmed it).
