# Keyframe escrow: threat model (contracts)

**Scope.** `KeyframeEscrowFactory`, `KeyframeVault` and the clones at each E, on Base, settling Base USDC. Off-chain
components appear only where they are part of the trust boundary. Status: unaudited, with a 50 USDC per-order cap (ADR-013).

**Assets.** Buyer USDC at E (≤ 50 USDC per order). The seller's right to be paid after a timely release. Whether the key
preimage `K_chain` is secret before release (once released, `K_chain` is public by design).

**Trust assumptions.** The Terms T a buyer pays into are what the plugin checked: the factory and seller are allowlisted, E is
recomputed locally, and `payTo == E`. The contracts then enforce T exactly, with no owner, admin, upgrade path or
pause. USDC (Circle) is trusted for transfers and can blacklist or pause. The `block.timestamp` from the Base sequencer is
trusted to within seconds, against windows of minutes to days.

| Actor | Can | Cannot |
|---|---|---|
| Buyer | fund E; `decide`/`decideBySig` during review; `refund` after the deadline | take funds before the deadline (Instant) or before the review/grace end (Studio); reject after accepting |
| Seller / operator (hot key) | `release` with K before the deadline, choosing `charge ≤ payoutAt`; `deliver`; `cancel` (all funds to the buyer) | redirect funds; be paid without K; be paid over `T.amount`; be paid after the deadline or grace; be paid if `T.seller ≠ SELLER` or `T.token ≠ USDC` |
| Anyone (keeper, attacker, front-runner) | `register` a funded E; `refund` / `refundExpired` once expired; `sweep` stray assets **to the buyer**; settle a leaked EIP-3009 authorization (funds still land at E) | release (even holding K); choose a recipient; move a non-terminal order's T.token; call `push` on any vault |
| Circle (USDC issuer) | blacklist a party, or E itself; pause | (outside the contracts' control) |

**Attacks and mitigations.**

| Attack | Mitigation in code | Test |
|---|---|---|
| Steal escrowed funds by calling the vault | `push` only from FACTORY; recipients come from T, which is bound by hash to E | `test_vault_onlyFactory`, I1, I8, I10 |
| Forge a T that maps to someone else's E | E = CREATE2(factory, EIP-712(T)), so a different T gives a different E; the EIP-712 domain binds chain and factory | `testFuzz_hashTerms_anyFieldChangesHash`, vectors |
| Release by a third party who saw K (mempool, logs) | release is limited to `T.seller` / `T.operator`; K is revealed only in the releasing tx | I10, `test_instant_revert_thirdPartyWithKey` |
| Seller over-charges or charges late | `charge ≤ payoutAt(T, now or deliveredAt) ≤ amount`; `now ≤ deadline` / `≤ reviewEnd + grace` | I2, I3, fuzz splits |
| Seller swaps the delivered file | Instant: `manifestHash == contentHash`; Studio: release must use the manifest recorded at `deliver` | `test_instant_revert_manifestMismatch`, `test_studio_revert_manifestMustMatchDelivered` |
| Double settlement / reopening | terminal states are absorbing; after terminal only `sweep` (to the buyer) works | I4, I5, `check_noDoubleSettle` |
| Front-running `fundWithAuthorization` | the signed `to == E`, so funds land at E; the factory falls through to registration when the nonce is used | fork `frontRunThenRegister` |
| Duplicate, late or stray deposits (USDC, junk ERC-20, ETH before deployment) | release change goes to the buyer; `sweep` moves any non-T.token at any time, and T.token after terminal, **to the buyer only** | I5, I7, fork `duplicateFundingThenSweep` |
| Re-entrancy through a malicious token or buyer contract | every mutator is `nonReentrant` (storage guard); state is written before value moves (except two documented USDC-only calls) | `test_sweep_reentrancyBlocked` |
| Register spam / keeper griefing | registration requires a funded E (≥ 0.10 USDC) that can only refund to its buyer; `refundExpired` is bounded by `maxScan`, and a failing entry is skipped, not reverted | `test_refundExpired_*`, fork bounded (≈ 94k gas per entry) |
| Over-cap or foreign-seller Terms | `valid(T)` at register and release: `amount ≤ 50 USDC`, `seller == SELLER`, `token == USDC`. Such T can only be refunded or cancelled | I9 |
| Replay of a review signature | `Decision` is EIP-712 under the factory domain with `sigDeadline`; accept is idempotent; reject is terminal; high-s ECDSA is rejected | `test_decideBySig_*` |
| EIP-7702-delegated buyer | `decideBySig` tries ECDSA before ERC-1271. USDC's own EIP-3009 check uses ERC-1271 for delegated EOAs, so they use the direct rail | `test_decideBySig_7702…`, fork 7702 tests |

**Residual risks (accepted, disclosed).**

- **Circle controls.** If the buyer is blacklisted, refunds revert and funds wait at E until unblacklisted. A blacklisted seller blocks
  only its own release, and the buyer still refunds after the deadline (fork-tested). If E is blacklisted, or USDC is paused past the
  deadline, nothing moves until Circle acts; then the normal guards apply. `refundExpired` skips those entries rather than stalling.
- **Delivery, not quality.** The contract guarantees the buyer gets the committed file's key or the money back. It does not judge the
  content. Studio adds a review window and a capped kill fee.
- **Operator key compromise.** An attacker with the key can `cancel` (refunding buyers) and spend gas. It cannot redirect funds, and it
  cannot release without K, which lives off-chain with KMASTER.
- **Bad Terms chosen off-chain.** A T that cannot be registered (bad deadline or seller) is still refundable after `T.deadline`,
  or at once via `cancel` by `T.seller`/`T.operator`. A huge `reviewWindow` or `deadline` delays the refund; the plugin bounds these
  before proposing payment. A T with `buyer` set to the factory would strand its refunds there, so the plugin must never produce one.
- **Unaudited code.** About 425 lines of logic over OZ v5.7.0 primitives, with 100% branch coverage, invariants, fork tests on real USDC and
  Halmos properties. There is a 50 USDC cap and no upgrade path: a bug means deploying a new factory, setting the old one to `refund-only`
  in the plugin env, and letting the keepers refund (ADR-013).
- **Timestamps.** The Base sequencer sets `block.timestamp`. A skew of a few seconds at a window edge can decide release versus refund for
  that order only.
