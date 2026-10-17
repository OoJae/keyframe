# ADR-019: API security hardening after the 2026-10 review

- Status: accepted
- Date: 2026-10-17
- Area: `apps/api` (paid path, keeper, relayer DO, lifecycle, direct rail, reviews, throttling)
- Related: ADR-002 (exactly-once), ADR-004 (contract as facilitator), ADR-007 (sanctions), ADR-012 (settle latency)

## Context

An independent review of `apps/api` found two high, six medium and seven low issues, each with a PoC. The two
high ones: settlement bookkeeping could be lost after money moved (client disconnect, D1 error, relayer RPC failing
after broadcast) while the API kept answering `charged: false`; and the paid-response replay store, keyed by the
public `(from, nonce)`, handed `access_token` and `k_buyer` to anyone who knew the quote id.

## Decision

Paid path
- claim → settle → record runs in one promise registered with `waitUntil`; the response awaits it. The order id is
  chosen before settlement and stored with the claim. Every bookkeeping statement is conditional on the quote still
  being `settling` under that claim, so request path and keeper can both record and exactly one order results.
- The facilitator reports what money did: settled, ambiguous (relayer call threw, fallback timed out), or nothing.
  Settled ⇒ record (even if x402 core failed afterwards). Ambiguous or "success without detail" ⇒ read the chain
  and adopt if T is registered or E holds the amount, else keep the claim and answer `charged: "unknown"`. Only a
  definite failure reopens the quote (402).
- The keeper adopts orphans older than 10 min the same way, reopens only when nothing is at E and the authorization
  is unused (`authorizationState`), and rotates unresolved ones to the back of the queue.
- Replays are bound to `sha256` of the exact payment header and served in full only within 120 s of settlement
  (and before `validBefore`); afterwards `access_token`/`k_buyer` are `null` with a SIWE recovery hint.
- Payloads must be exactly `{authorization, signature}` (no Permit2), and the verifier's payer must equal `from`.
- The PayAI fallback never fails on a timeout without checking `authorizationState` and E's balance.

Studio "changes" (policy decided by the builder)
- After a change request silence never releases. One revision may be delivered (off-chain; the contract knows one
  `deliver`). Only an explicit accept releases: `decideBySig` inside the review window, an off-chain verified
  `Decision(accept)` after it until `accept_by`; a reject after the window is answered with `cancel`. Without an
  accept the keeper refunds at review end + grace. Documented in the API README and returned as `policy`.

Chain and relayer
- "Dropped" requires the nonce and the (missing) receipt from one node (a JSON-RPC batch) and must persist for 60 s;
  `confirmFunding` re-reads `order(termsHash)` / E's balance before marking an order failed.
- Release is never sent within 120 s of its last valid second, and `order()` is read before release calldata (which
  carries K_chain) is built.
- refundExpired is sent only when `refundableCount(20)` and an `eth_call` of `refundExpired(20)` both say it makes
  progress; per-order `refund(T)` from the DB stays the primary path.
- The DO refuses non-fund sends beyond `RELAYER_TX_PER_HOUR` and alarms below `RELAYER_LOW_BALANCE_WEI`.
- Late-fund returns take a per-quote slot and ignore dust; direct-rail deposits are screened per sender (USDC
  Transfer logs into E). A sanctioned sender's funds are not touched: the quote is cancelled, refundable to T.buyer.

Abuse and hygiene
- Per-client (hashed CF-Connecting-IP) D1 token buckets on quotes, `/rail`, paid requests, SIWE and reviews, plus an
  optional Workers Rate Limiting binding for all `/v1`; render-queue caps per client and in total, round-robin claims.
- Bodies are read with a Content-Length check and a streaming cap.
- Content policy runs on normalised, folded text and on nested catalog/portfolio strings; bare domains are links.
- Drafts say `payable: false` and mark their escrow provisional. Error text is redacted (no RPC URLs, bodies, keys).
- Quotes outside the factory's new bounds (review window > 14 d, kill fee > 5000 bps) are refused.

## Consequences

- Schema: `migrations/0002_hardening.sql` (additive columns, `rate_buckets`). Apply before deploying.
- Frozen surface (§7): all response changes are additive, with two deliberate value changes the builder decided:
  `charged` may be the string `"unknown"` (never on a pre-settlement refusal), and a replay of a settled payment
  after the 120 s window carries `access_token: null` (the plugin's `PaidResponseSchema` requires a 43-char string;
  such a late replay now steers the agent to `keyframe_orders` instead). A forged or re-encoded header for a settled
  authorization gets 409 `authorization_reused` instead of the body.
- The plugin's `keyframe_review` still refuses after the on-chain review window; an off-chain accept of a revision
  after it is reachable through the API (`accept_by`) and should be surfaced by the plugin.
