# ADR-012: Settle latency mode: wait briefly for the receipt, then answer "pending"

- Status: accepted provisionally; revisit with spike S8's measured paid-retry timeout
- Date: 2026-10-17
- Area: `apps/api` (`src/x402/facilitator.ts`, `src/relayer/core.ts`, `src/orders/lifecycle.ts`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

The paid response should arrive in about 2 s. PayBox's tolerance for a slow paid retry is unverified (U4/S8). Base
blocks are about 2 s apart, and `mainnet.base.org` returns receipts at Flashblock inclusion (about 200 ms). x402
core retries a facilitator answer of `settlement_pending`, which would re-run settlement.

## Decision

- The relayer simulates the call (`estimateGas`), signs with a managed nonce, broadcasts, and waits for the receipt
  for at most `RECEIPT_WAIT_MS` (default 1200).
- If the receipt arrives, `funding: "confirmed"`. Otherwise the facilitator still returns `success: true` with the
  tx hash, the paid body says `funding: "pending"`, and the order starts as `funding`. The facilitator never returns
  `settlement_pending`.
- The order is confirmed later, either by the request's `waitUntil` follow-up or by the cron keeper. The relayer DO
  keeps every signed raw transaction until its receipt is seen. If a node loses one whose nonce is unused, the DO
  re-broadcasts it. If the nonce was used by another transaction, the tx is reported dropped. A reverted funding tx
  marks the order `failed`: nothing moved, and the keeper refunds any funds that later appear at E.

## Consequences

- On a local EVM the paid round-trip is about 300 ms, inside workerd with the Durable Object (`smoke-local.mjs`).
- A client may see `funding: "pending"`. The plugin's `keyframe_verify funding` then reads the chain, which is
  the source of truth.
- Not done: fee bumping of a transaction stuck in the mempool (rare on Base). It is listed as an open item.
