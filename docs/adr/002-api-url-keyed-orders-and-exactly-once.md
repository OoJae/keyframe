# ADR-002: URL-keyed x402 orders, body ignored; verify, check, claim, then settle exactly once

- Status: accepted (engineering), for the builder's review
- Date: 2026-10-17
- Area: `apps/api` (`src/orders/paid.ts`, `src/x402/*`, `migrations/0001_init.sql`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

PayBox's unpaid probe and its paid retry may differ in method and body, and the probe may send no body at all.
The resource must therefore be identified by the URL alone. Once a valid EIP-3009 authorization arrives, money
can move exactly once, and only after every business rule has passed: a wrong payer, a sanctioned payer, an expired
quote or a full studio must never reach settlement. Clients also retry. A retried request with the same
authorization must get the same answer, byte for byte, and must not send a second transaction.

## Decision

- The x402 resource is `ALL /v1/orders/{quote_id}`. The request body is never read, and every method behaves the same.
- The paid path runs in this order:
  1. **Replay.** A stored response for `(from, nonce)` is returned byte-identically (status, headers, body). If another
     request currently holds that authorization, wait up to 4 s for its stored response, then answer
     409 `settlement_in_progress`.
  2. **Gate.** Draft → 425. Expired or cancelled → 410. Paid → 409. Maintenance or misconfiguration → 503.
  3. **Verify.** x402's own exact-EVM verifier runs locally against the stored final quote: signature, `to == E`,
     `value == T.amount`, the validity window, and an `eth_call` simulation. A failure answers 402.
  4. **Business checks.** `from == T.buyer` else 409. OFAC else 451 (screening unavailable → 503). Capacity else
     503. Quote still live and `deadline − now ≥ MIN_RELEASE_MARGIN_S` else 410. Every refusal carries `charged: false`.
  5. **Claim (CAS in D1).** Insert the payments row `(from, nonce)`, which revives a previously failed row. Then
     `UPDATE quotes SET status='settling' WHERE id=? AND status='final' AND quote_expires_at > now`. Only the request
     that wins both steps settles. A loser holding the same authorization waits and replays. A loser with a
     different authorization gets 409.
  6. **Settle** through `x402HTTPResourceServer.processSettlement`, which uses contract-as-facilitator (ADR-004).
     Then the order row, `quote → paid` and the stored response are written in one D1 batch, and the answer is 200.
- A settlement failure releases the claim (the quote is payable again) and answers 402 with a failing
  `PAYMENT-RESPONSE`.

## Consequences

- Ten parallel retries of one authorization produce one `fundWithAuthorization` and ten identical bodies.
  Five different authorizations for one quote produce one 200 and four 409s. Both cases are tested, including on a
  real EVM (`test/anvil.e2e.test.ts`).
- The response a client sees for an authorization is stable forever, which suits PayBox's `get_request` polling.
- If an isolate dies between settlement and bookkeeping, the quote stays `settling`. The keeper reopens it when
  nothing reached E. Otherwise it logs an orphan, and the funds stay refundable on-chain (`refundExpired`).
