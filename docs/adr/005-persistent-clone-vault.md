# ADR-005: Persistent EIP-1167 clone vault, no SELFDESTRUCT

- Status: proposed (drafted for the builder's review)
- Date: 2026-10-17
- Area: `contracts/` (`KeyframeVault`, `KeyframeEscrowFactory`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

Funds for an order must sit at an address computable before payment (the x402 `payTo`), derived only from the deal.
Earlier designs used a CREATE2 "runner" that self-destructs after moving funds, or transient-storage tricks. After
EIP-6780 (Cancun), SELFDESTRUCT only clears code in the creating transaction, which makes redeploy-at-the-same-address
patterns fragile and hard to audit. Solady's `LibClone` uses a non-canonical proxy, which Basescan does not label and which
a plugin would have to special-case.

## Decision

- `E = Clones.predictDeterministicAddress(VAULT_IMPL, termsHash, factory)` (OpenZeppelin v5.7.0, canonical EIP-1167:
  init code `3d602d80600a3d3981f3363d3d373d3d3d363d73 ‖ VAULT_IMPL ‖ 5af43d82803e903d91602b57fd5bf3`).
- `VAULT_IMPL` is the factory's only CREATE, so it equals `getContractAddress(factory, nonce 1)`. The plugin derives
  everything from the factory address alone.
- The clone is deployed **lazily**, by the first call that actually moves funds out of E, and is **persistent**. There is no
  SELFDESTRUCT, no transient storage and no initializer.
- `KeyframeVault` has no storage, no `receive()` and no `fallback()`, and a single `push(token, to, amount)` callable only by
  its `FACTORY` immutable (`msg.sender` at implementation deployment, visible to every clone through the implementation code).
  The factory always picks `to` from T (buyer or seller).

## Consequences

- Before payment and while funded, E is a codeless address holding USDC, which is what the 402 advertises. After the first payout it is a
  textbook "Minimal Proxy" on Basescan. Its code is checked as exactly the canonical runtime (`invariant_escrowCodeIsCanonical`).
- Funds arriving after settlement (duplicates, late payments, stray tokens, ETH sent before deployment) stay recoverable
  forever through `sweep`, always to T.buyer.
- The first call that moves funds pays a one-off clone deployment of about 41k gas (fork: `sweep` costs 123k on a fresh E and 82k once the clone exists). Cancelling an unfunded order deploys nothing.
- After the clone exists, ETH cannot be sent to E (no `receive`). ETH forced in (coinbase, or SELFDESTRUCT from elsewhere) is still sweepable.
