# ADR-007: Sanctions screening off-chain, not in the escrow

- Status: proposed (drafted for the builder's review)
- Date: 2026-10-17
- Area: `contracts/` (no on-chain hook), API paid path
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

Keyframe must not take payment from sanctioned addresses. One option is an on-chain oracle check (Chainalysis-style)
inside `register` / `fundWithAuthorization` / `refund`. That would add a third-party admin to an otherwise ownerless
escrow. An oracle that can only *block* would also turn refunds into permanent freezes, which is the worst outcome
for an honest buyer misclassified for a moment. The oracle's address on Base is also unverified (architecture §8).

## Decision

- The factory has **no sanctions hook and no oracle dependency**. Refunds, cancels and sweeps can never be blocked by Keyframe.
- Screening happens off-chain:
  - at quote time and again in the paid handler **before settlement**, against the OFAC SDN ETH list (lowercased,
    refreshed daily, last good copy kept, failing closed if stale for more than 7 days);
  - a sanctioned payer gets HTTP 451 and the authorization is never submitted.
- Circle's USDC blacklist is the token-level on-chain backstop. A blacklisted party cannot move USDC at all, and the
  escrow's behaviour under the blacklist is fork-tested: a blacklisted seller cannot block a buyer refund; a blacklisted buyer's
  refund waits until Circle acts, and keepers skip it instead of stalling.

## Consequences

- The escrow stays ownerless and immutable, with nothing to upgrade or pause.
- A buyer who pays E directly, bypassing the API, cannot be screened before funding. The studio never releases to such an
  order. `cancel` returns funds to the payer, and the API logs and reports per policy.
- There is a list-lag window between an SDN designation and our daily refresh (disclosed).
- The open-source factory could later ship an optional oracle constructor variant for other sellers. Keyframe's deployment
  would not use it.
