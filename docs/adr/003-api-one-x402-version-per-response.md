# ADR-003: One x402 wire version per response, byte-identical per quote

- Status: accepted (engineering), for the builder's review
- Date: 2026-10-17
- Area: `apps/api` (`src/x402/server.ts`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

The plugin's 402 parser rejects a response that mixes v1 and v2 (frozen §7). The plugin pre-fetches the 402 and
asserts `payTo == E` and `amount == T.amount`. PayBox fetches it again at approval time. Any difference between
those fetches (a timestamp, the request's host or scheme, an HTML paywall chosen by `Accept`) is a payment failure
or a red flag.

## Decision

- The default wire is **v2**. `@x402/core`'s `x402HTTPResourceServer` emits the 402, with `DynamicPayTo` = E and
  `DynamicPrice` = `T.amount` read from the stored final quote, and `extra {name:"USD Coin", version:"2"}`. Its
  response is the `PAYMENT-REQUIRED` header with body `{}`. No `unpaidResponseBody` is configured, so the body is
  exactly frozen §7.
- A canonical adapter feeds the core server. The resource URL is `PUBLIC_BASE_URL + /v1/orders/{quote_id}`. Accept is
  always `application/json` and the user agent is empty, so the HTML paywall branch can never run. The adapter
  exposes no request header except `PAYMENT-SIGNATURE`. The description is fixed per quote: title, duration,
  aspect, a shortened E and the deadline, with no clock.
- `X402_WIRE=v1` switches to a v1 JSON body (`network:"base"`, `maxAmountRequired`) with no header. It is emitted
  in the field order of `@keyframe/protocol`'s `buildPaymentRequiredV1`.
- Both v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`) payments are accepted whichever wire is advertised. The
  signature commits to `to = E` and `value = T.amount`, so either is safe. A cosmetic difference in the echoed
  `accepted` block (address case) is normalised, but only when the **signed** authorization pays exactly our E and
  amount.

## Consequences

- Tests pin the exact bytes. The v2 header equals `buildPaymentRequiredV2` byte for byte, and the decoded JSON is
  the literal frozen §7 string. POST/GET/PUT/DELETE, a browser `Accept` with a Mozilla user agent, and forwarded
  host headers all yield one header value. This also holds in workerd (`scripts/smoke-local.mjs`).
- A draft, expired, cancelled or paid quote never serves a 402 (425 / 410 / 409).
- The wire can be flipped after the plugin upload lock without a redeploy of the plugin.
