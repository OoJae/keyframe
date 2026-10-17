# Keyframe

**Hire a motion designer from chat, and pay only on delivery.**

Keyframe is a [PayBox](https://paybox.sh) plugin, built for MoonPay Hackathons Chapter 1. Ask your agent for a short
motion piece. It renders before you pay. One PayBox tap seals your USDC in an escrow on Base, and the studio gets paid
only by publishing the key to your file before the deadline. If it misses the deadline, the money comes back to you
without any action on your part.

- Live on Base mainnet. Escrow factory [`0xd9d5…e561`](https://basescan.org/address/0xd9d55954366Bb9ce979B992DE7218DAF1d61e561),
  source verified on [Sourcify](https://sourcify.dev/server/v2/contract/8453/0xd9d55954366Bb9ce979B992DE7218DAF1d61e561).
- API: <https://keyframe-api.keyframe-spike-server.workers.dev> ([llms.txt](https://keyframe-api.keyframe-spike-server.workers.dev/llms.txt),
  [live counters](https://keyframe-api.keyframe-spike-server.workers.dev/v1/stats)).
- First real order, placed from Claude.ai: sealed, key published and verified 16/16 in
  [docs/evidence/LIVE.md](docs/evidence/LIVE.md).

## Try it ($1, about two minutes)

In a chat connected to PayBox (Claude.ai, ChatGPT or Grok), with the Keyframe plugin enabled and at least $1 of USDC on
Base in your wallet:

> Use Keyframe to make me a countdown video for our launch on Friday at 7pm WAT. Label it "Mainnet".

1. **Quote.** About 15 seconds later you see a watermarked preview, the price and the deadline. You haven't paid
   anything yet.
2. **One tap.** Approve the 1.00 USDC payment in the PayBox window. It's gasless. The first payment in a new chat asks
   you to connect your signing key.
3. **Your file.** Seconds later the key is published on Base. Your agent checks the file against the deal and gives you
   a watch & download link. The page opens the video in your browser with the key read from Base
   ([example: the first mainnet order](https://keyframe-api.keyframe-spike-server.workers.dev/w/o_YF8xCvJy3fusQUQzaJCMjG)).

If the studio is late, the keeper refunds you automatically; you don't need to do anything. Today you can order Countdown
(instant, $1) and Studio commissions (made by hand). The other formats in the catalog are marked "coming soon".

## How the guarantee works

Think of it as a sealed envelope.

1. **Rendered first.** Before you pay, Keyframe renders and encrypts your file and commits its hash into the deal.
2. **The address is the deal.** Your USDC goes to an address computed from the deal terms (CREATE2). It has no owner.
   Money there can reach only two places: the studio, with the key, or back to you.
3. **The key is the payment trigger.** The studio is paid only by publishing the file's key on Base before the
   deadline. After the deadline, anyone can return your money: the keeper does it automatically, and you can do it
   yourself with `keyframe_refund`.

**Guaranteed:** you get exactly the file you previewed, or your money back. **Not guaranteed:** that you'll like it,
which is why you see the preview first. Studio commissions add a review window, one revision, and accept, change or
reject.

Verify any order yourself, without trusting Keyframe's server: `keyframe_verify` recomputes the escrow address,
reads the key from Base on three independent RPCs, decrypts the file and checks every hash.

## Honest limits

- The contracts are **unaudited**, so orders are capped at 50 USDC. They have been through an internal security review,
  and its findings are fixed. The deployed factory differs from `main` in one gas-safety constant; see
  [docs/deploy/factory-v1.md](docs/deploy/factory-v1.md).
- **Public delivery:** once the key is published, anyone with the link can open the file. Choose `delivery: "private"`
  for launches that haven't been announced.
- Pieces are silent for now.
- The render studio is one machine. If it's offline, quotes fail fast and nothing is charged.

## For engineers

| Path | What |
|---|---|
| `contracts/` | `KeyframeEscrowFactory` and `KeyframeVault` (Foundry: unit, fuzz, invariant, Base-fork and Halmos tests) |
| `plugin/` | The PayBox plugin: 9 tools, starter v1.0.2, bundled to `dist/plugin.mjs` |
| `packages/protocol/` | Terms v1, EIP-712, CREATE2 derivation, KFC1 encryption, shared test vectors |
| `apps/api/` | x402 API on Cloudflare Workers (D1, R2, a Durable Object relayer, cron keeper) |
| `apps/worker/` | Render worker: HyperFrames → MP4 → KFC1 encryption |
| `templates/` | Motion templates (the builder's craft) |
| `docs/` | Design, ADRs, evidence |

Start with [docs/design/frozen-interfaces.md](docs/design/frozen-interfaces.md). `scripts/e2e-fork.sh` runs the
whole system end to end on a Base-mainnet fork with real USDC.

Lineage: hash-time-locked contracts and zero-knowledge contingent payments (ZKCP). Keyframe is a "ZKCP-lite" for x402:
the buyer verifies the hash commitments themselves rather than relying on a proof, and payment is one `exact` USDC
authorization on Base.

## Licence and credits

The code is MIT ([LICENSE](LICENSE)). The motion templates in `templates/` are all rights reserved
([templates/LICENSE](templates/LICENSE)).
