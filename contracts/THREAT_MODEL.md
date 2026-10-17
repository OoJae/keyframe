# Keyframe escrow: threat model (contracts)

**Scope.** `KeyframeEscrowFactory`, `KeyframeVault` and the clones at each E, on Base, settling Base USDC. Off-chain
components appear only where they are part of the trust boundary. Status: one independent audit, findings fixed (see Residual
risks), with a 50 USDC per-order cap (ADR-013).

**Assets.** Buyer USDC at E (≤ 50 USDC per order). The seller's right to be paid after a timely release. Whether the key
preimage `K_chain` is secret before release (once released, `K_chain` is public by design).

**Trust assumptions.** The Terms T a buyer pays into are what the plugin checked: the factory and seller are allowlisted, E is
recomputed locally, and `payTo == E`. The contracts then enforce T exactly, with no owner, admin, upgrade path or
pause. USDC (Circle) is trusted for transfers and can blacklist or pause. The `block.timestamp` from the Base sequencer is
trusted to within seconds, against windows of minutes to days.

| Actor | Can | Cannot |
|---|---|---|
| Buyer | fund E; `decide`/`decideBySig` during review; `refund` after the deadline | take funds before the deadline (Instant) or before the review/grace end (Studio); reject after accepting; block the seller's payout by being unable to receive change |
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
| Pin or starve the keeper (audit M1): an unpayable entry (buyer blacklisted) or a block of long-lived orders in front of the scan window, so later expired orders are never reached and `refundableCount` stays > 0 forever | an already-blacklisted buyer is rejected at registration (`BadTerms(4)`); the keeper window rotates over the whole live range from a private cursor, so no entry can starve the ones behind it; `refundableCount` scans the same window and skips unpayable entries (USDC paused, buyer or E blacklisted), so the keeper condition goes false | `test_M1_*`, `testFuzz_M1_rotationReachesEveryRefundable`, `invariant_keeperRotationReachesEveryRefundable`, `check_keeperCountMatchesRefunds`, fork `M1_*` |
| Block the seller's payout from the buyer side (audit L1): donate 1 unit to E so change > 0, with a blacklisted buyer, so the release reverts (and K leaks in the reverted calldata) | the seller push is strict, the buyer push best-effort: undelivered change stays at E, `toBuyer` reports 0, and only `sweep` can move it, to the buyer | `test_L1_*`, `invariant_exitsAreLive` (buyers blacklisted at random), `invariant_toBuyerNeverOverstated`, `check_releasePaysSellerDespiteUnpayableBuyer`, fork `L1_*` |
| Gas-starve the best-effort push (63/64 rule), or let `eth_estimateGas` settle on a limit at which it silently fails | `_tryPush` reverts when the failed push left less than 1/8 of the gas (an out-of-gas anywhere in the nested calls); only token-level refusals are swallowed | `test_L1_buyerPushCannotBeGasStarved`, `test_L1_keeperRefundCannotBeGasStarved` (token with 600k-gas transfers), `test_L1_estimateGasMinimumDeliversChange` |
| Lock funds with an extreme Studio review window or kill fee (audit L2) | `reviewWindow ≤ MAX_REVIEW_WINDOW` (14 days, `BadTerms(9)`) and `killFeeBps ≤ MAX_KILL_FEE_BPS` (50%, `BadTerms(5)`); worst-case lock is 47 days after registration | `test_L2_*`, `test_register_revert_{reviewWindow,killFee}AboveCap`, I9 |
| Register Terms whose refunds strand funds in a protocol contract (audit Info 1) | `buyer ∉ {factory, VAULT_IMPL, USDC}` at register and release (`BadTerms(4)`) | `test_register_revert_buyerIsProtocolContract`, `test_info1_buyerIsFactoryRejected` |
| Over-cap or foreign-seller Terms | `valid(T)` at register and release: `amount ≤ 50 USDC`, `seller == SELLER`, `token == USDC`. Such T can only be refunded or cancelled | I9 |
| Replay of a review signature | `Decision` is EIP-712 under the factory domain with `sigDeadline`; accept is idempotent; reject is terminal; high-s ECDSA is rejected | `test_decideBySig_*` |
| EIP-7702-delegated buyer | `decideBySig` tries ECDSA before ERC-1271. USDC's own EIP-3009 check uses ERC-1271 for delegated EOAs, so they use the direct rail | `test_decideBySig_7702…`, fork 7702 tests |

**Residual risks (accepted, disclosed).**

- **Circle controls.** A buyer that is already blacklisted cannot be registered. If the buyer is blacklisted later, refunds revert
  and funds wait at E until unblacklisted; a release or reject still pays the seller, and the buyer's change waits at E for `sweep`.
  A blacklisted seller blocks only its own release, and the buyer still refunds after the deadline (fork-tested). If E is
  blacklisted, or USDC is paused past the deadline, nothing moves until Circle acts; then the normal guards apply.
  `refundExpired` skips those entries rather than stalling, and `refundableCount` does not count them.
- **A permanently unpayable entry stops `scanFrom`.** An order whose buyer (or E) stays blacklisted is never terminal, so `scanFrom`
  cannot pass it. The rotation still reaches every other entry, but the live range `[scanFrom, length)` then keeps every later
  order, terminal or not, and one full rotation costs about 4.5k gas per terminal entry (two cold storage reads; ≈ 90k per `refundExpired(20)`).
  `refundableCount(type(uint256).max)` is an `eth_call` of about 5k gas per entry, which fits a 50M-gas RPC cap up to about
  10 000 entries in the live range. The API keeper also refunds expired orders one by one with `refund(T)`, so the batch is a
  backstop, not the only path. A future factory could compact behind such entries; this one does not, by design (registry
  order is preserved).
- **Keeper condition window.** `refundableCount(k)` sees only the next k entries of the rotation. A keeper that uses a small k as
  its condition can stop firing while refundable orders sit further along. Use `refundableCount(type(uint256).max)` (exact) as
  the condition and any `refundExpired(k)` as the action.
- **`Swept` reports what the token says (audit Info 2).** `sweep(T, token)` for an arbitrary token emits
  `Swept(h, token, balanceOf(E))` and may deploy the clone before the buyer pays. Indexers must only treat `Swept` as money when
  `token == USDC`. Nothing moves to anyone but `T.buyer`, and the order stays usable (`test_info2_sweepOfForeignTokenIsHarmless`).
- **Reverted releases leak K (audit Info 3).** `release` carries `K_chain` in calldata, and a reverted release still publishes it.
  A third party holding K still cannot release (I10), but the buyer learns K without the seller being paid. The operator must
  simulate the release immediately before sending it, use `charge ≤ payoutAt(T, now + margin)`, and stay clear of window edges
  (README, "Operating `release` safely").
- **Delivery, not quality.** The contract guarantees the buyer gets the committed file's key or the money back. It does not judge the
  content. Studio adds a review window and a capped kill fee.
- **Operator key compromise.** An attacker with the key can `cancel` (refunding buyers) and spend gas. It cannot redirect funds, and it
  cannot release without K, which lives off-chain with KMASTER.
- **Bad Terms chosen off-chain.** A T that cannot be registered (bad deadline, seller, review window, kill fee or buyer) is still
  refundable after `T.deadline`, or at once via `cancel` by `T.seller`/`T.operator`. Registration caps the review window at
  14 days and the kill fee at 50%, and rejects a buyer equal to the factory, `VAULT_IMPL` or USDC. Funds sent to the E of an
  *unregistered* T whose buyer is such a contract can still only leave to that buyer, so they would be stranded there. That case
  is self-inflicted, and the plugin never builds such Terms (it binds `T.buyer` to the signer).
- **Audit status.** One independent review (2026-10-17): M1, L1, L2 and Info 1 fixed, Info 2 accepted and documented, Info 3
  addressed operationally. About 500 lines of logic over OZ v5.7.0 primitives, with 100% branch coverage, invariants, fork tests on
  real USDC and Halmos properties. There is a 50 USDC cap and no upgrade path: a bug means deploying a new factory, setting the old
  one to `refund-only` in the plugin env, and letting the keepers refund (ADR-013).
- **Timestamps.** The Base sequencer sets `block.timestamp`. A skew of a few seconds at a window edge can decide release versus refund for
  that order only.
