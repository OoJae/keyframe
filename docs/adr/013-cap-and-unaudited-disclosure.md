# ADR-013: 50 USDC per-order cap and "unaudited" disclosure

- Status: proposed (drafted for the builder's review)
- Date: 2026-10-17
- Area: `contracts/` (`MIN_AMOUNT`, `MAX_AMOUNT`, `MAX_LIFETIME`), plugin `KEYFRAME_MAX_AMOUNT`, all user copy
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

The escrow is new code holding other people's money, with no admin and no upgrade path. There is no time for a professional
audit before the hackathon lock. The product's prices are 0.10–50 USDC (probe through Studio Spot).

## Decision

- Hard-coded constants in the factory: `MIN_AMOUNT = 100_000` (0.10 USDC spam floor), `MAX_AMOUNT = 50_000_000` (50 USDC),
  `MAX_LIFETIME = 30 days`, `RELEASE_GRACE = 3 days`. `valid(T)` enforces them at registration **and** at release. An
  over-cap T can only be refunded or cancelled; it can never be registered or pay a seller (invariant I9).
- The plugin's `KEYFRAME_MAX_AMOUNT` must be ≤ 50 USDC, and the plugin refuses to propose anything above it.
- Every user-facing surface says plainly: **"unaudited smart contract, max 50 USDC per order"**. The README and
  THREAT_MODEL carry the same statement.
- Assurance instead of an audit, all reproducible from `contracts/README.md`:
  - 100% branch coverage on the factory, vault and TermsLib;
  - fuzzing (20k runs in `deep`);
  - a handler-based invariant campaign encoding I1–I10;
  - Base fork tests against the real FiatTokenV2_2;
  - Halmos symbolic properties;
  - cross-language vector parity with `packages/protocol`.

## Consequences

- Worst-case loss per order is bounded at 50 USDC, and per bug class by the number of live orders.
- Raising the cap means deploying a new factory (new address, same ABI). The plugin picks it up through the
  `KEYFRAME_FACTORIES` env allowlist, and the old factory is marked `refund-only` so keepers drain it.
- Response to a found bug: stop quoting (maintenance flag), `cancel` open orders (refunds), deploy a fixed factory, update env.
  Nothing in the old factory can be paused, and nothing needs to be.
