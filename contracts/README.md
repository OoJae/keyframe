# Keyframe escrow contracts

Pay-on-delivery escrow for Keyframe orders on Base. Every order is a `Terms` struct. Its escrow address
`E = escrowOf(hashTerms(T))` is a counterfactual EIP-1167 clone: the buyer pays a codeless address that already
encodes the deal. The seller is paid only by publishing the key preimage on-chain in time. Otherwise everything
goes back to the buyer.

The source of truth is [`docs/design/frozen-interfaces.md`](../docs/design/frozen-interfaces.md) §1–§3. These
contracts implement it exactly; the [interpretations](#interpretations-of-the-frozen-spec) below cover cases the
spec leaves open. Status: **one independent audit, findings fixed** ([audit fixes](#audit-fixes-2026-10-17)), per-order cap
50 USDC (ADR-013). The factory is not deployed yet; the fixes change its init code and therefore its CREATE2 address.

| | |
|---|---|
| Toolchain | Foundry 1.8.3, solc 0.8.30, `evm_version = cancun`, optimizer 10 000 runs, no via-IR, no CBOR metadata |
| Libraries | OpenZeppelin Contracts **v5.7.0** (`cab1993`), forge-std **v1.17.0** (`f3dae6e`), pinned in `foundry.lock` (git submodules) |
| Chain / token | Base `8453`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (FiatTokenV2_2) |

## Layout

```
src/KeyframeEscrowFactory.sol          ownerless factory: state machine, registry, payouts (implements the interface)
src/KeyframeVault.sol                  clone implementation: push(token,to,amount), only FACTORY, no storage, no receive
src/interfaces/IKeyframeEscrowFactory.sol   frozen ABI: Terms, Status, OrderView, events, errors, functions
src/interfaces/IERC3009.sol            FiatTokenV2_2 subset (bytes-signature transferWithAuthorization, authorizationState)
src/interfaces/IFiatTokenV2_2.sol      FiatTokenV2_2 read-only subset (isBlacklisted, paused) for best-effort pre-checks
src/libraries/TermsLib.sol             EIP-712 typehashes + struct hash, domain separator, CREATE/CREATE2 derivation, payoutAt
test/unit/                             every function, revert path and event (147 tests)
test/unit/AuditRegressions.t.sol       the auditor's PoCs (M1, L1, L2, Info 1-2) ported as regressions (19 tests)
test/fuzz/                             payoutAt properties, hashing and derivation, money splits and timing windows
test/invariant/                        handler (buyers/seller/operator/attacker/keeper) + ghost ledgers, I1–I10
test/fork/BaseFork.t.sol               Base mainnet fork, real USDC, pinned block 52 705 000 (24 tests)
test/Vectors.t.sol                     cross-language vectors -> test/vectors/terms-v1.output.json
test/halmos/KeyframeEscrowSym.t.sol    symbolic properties (check_*)
script/Deploy.s.sol                    deterministic CREATE2 deployment + deployments/<chainid>.json
script/Smoke.s.sol                     local-anvil smoke order (0.10 USDC fundWithAuthorization -> release)
snapshots/KeyframeFork.json            per-path gas on the fork (real USDC)
halmos.toml                            Halmos settings (contract, build dir)
.gas-snapshot                          forge snapshot for unit/fuzz/vectors (CI gate)
```

## Interface summary

The full ABI is in [`IKeyframeEscrowFactory.sol`](src/interfaces/IKeyframeEscrowFactory.sol).

- **Derivation.** `termsHash` is the EIP-712 digest under the domain `{name:"Keyframe Escrow", version:"1", chainId, verifyingContract: factory}`;
  `eip712Domain()` (ERC-5267) is exposed. `VAULT_IMPL` is the factory's only CREATE, so it equals
  `getContractAddress(factory, nonce 1)`. `E = Clones.predictDeterministicAddress(VAULT_IMPL, termsHash, factory)`.
  The clone is deployed lazily by the first call that moves funds out of E and stays deployed. There is no SELFDESTRUCT
  and no transient storage.
- **Funding.** `fundWithAuthorization(T, validAfter, validBefore, nonce, sig)` makes the contract the facilitator. It calls USDC's
  `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)` with `from = T.buyer`,
  `to = E`, `value = T.amount`, then registers T in the same tx (ADR-004). If the authorization was already executed
  (`authorizationState(buyer, nonce) == true`, for example by a front-runner or another facilitator), it falls through to
  registration, which still requires `balanceOf(E) ≥ amount`. Any other USDC revert is bubbled unchanged.
  `register(T)` is the permissionless path for funds that are already at E.
- **Seller side** (`T.seller` or `T.operator`): `release(T, key, charge, manifestHash)`, `deliver(T, manifestHash)` (Studio), `cancel(T)`.
- **Buyer side:** `decide(T, accept)` (msg.sender == T.buyer) and `decideBySig(T, accept, sigDeadline, sig)`. `decideBySig` checks
  `ECDSA.tryRecover` first and ERC-1271 second. It deliberately avoids `SignatureChecker.isValidSignatureNow`,
  because an EIP-7702-delegated EOA has code but signs with ECDSA.
- **Anyone:** `refund(T)`, `refundExpired(maxScan)` (keepers; `refundableCount(maxScan)` is the matching view), `sweep(T, token)`.
- **Views:** `hashTerms`, `escrowOf`, `payoutAt`, `order` (state, K once released, manifest hash, payouts; plugins need no
  `getLogs`), `registryLength`. Additive (audit fixes, listed as additive in frozen §3): `scanFrom()`,
  `MAX_REVIEW_WINDOW()` (14 days) and `MAX_KILL_FEE_BPS()` (5000), plus `BadTerms(9)` for a review window over the cap.
- **Keepers.** Use `refundableCount(type(uint256).max) > 0` as the condition and `refundExpired(20)` as the action. The
  window rotates (see interpretation 5), so every action makes progress and the condition reaches 0. A bounded condition
  such as `refundableCount(50)` can read 0 while refundable orders sit more than 50 entries past the cursor.

### Interpretations of the frozen spec

None of these change a frozen signature, event, error or transition. They decide cases the table leaves open:

1. **Registration after an unregistered terminal state.** Cancelling or refunding a never-registered T writes a record
   (status, buyer, deadline, reviewWindow, finalAt, toBuyer). `register`/`fundWithAuthorization` then revert. The error
   is `AlreadyRegistered()` if the order was ever registered (`openedAt != 0`); otherwise it is `BadStatus(status)`.
2. **`deliver` on Instant Terms** (`reviewWindow == 0`) reverts `BadStatus(1)`. **`deliver` honours a non-zero
   `contentHash`**: Studio Terms carry `contentHash == 0`, so this only tightens a case the spec says never occurs.
3. **Accept is idempotent.** It re-emits `Decided(h, true, 0)`. **Reject after accept** reverts `BadStatus(2)`. No signature nonce is
   needed, because replaying an accept changes nothing and a reject can succeed only once.
4. **`sweep` with a zero balance** is a silent no-op: no event, no clone deploy.
5. **`refundExpired` uses a rotating window** over the live range `[scanFrom, registryLength)`: `min(maxScan, live)` entries
   from a private cursor, wrapping back to `scanFrom`, after which the cursor moves past the window. An entry whose transfer
   fails (USDC paused, buyer or E blacklisted) is skipped instead of reverting the batch; it stays non-terminal, so `scanFrom`
   stops in front of it, but the rotation keeps reaching the entries behind it, and `refund(T)` remains available.
   `refundableCount(maxScan)` inspects the same window and counts only refundable *and payable* entries, so it equals what
   `refundExpired(maxScan)` would return in the same state (frozen §3 has the exact wording).
6. **`T.token == address(0)`** is treated as native ETH by `refund`/`cancel`/`sweep`. This matters only for
   unregistered Terms, because registration requires `token == USDC`.
7. **`payoutAt` is the frozen integer formula verbatim.** No product can overflow for registrable Terms (amount ≤ 50e6,
   64-bit timestamps). For absurd pure-call inputs (amount above about 2^190) it reverts with an arithmetic panic, as the formula
   implies. TypeScript bigint ports agree on every input that does not revert (vectors, fuzz).
8. **`OrderView.toSeller` / `toBuyer`** record the terminal transition. Later sweeps are reported by `Swept` events.
9. **The constructor** rejects a codeless `usdc` (`BadTerms(1)`) and a zero `seller` (`BadTerms(3)`). This is a deploy-time guard only.
10. **Checks-effects-interactions.** Three calls deliberately interact before writing state. All target the validated USDC,
    which has no hooks, and every entry point is `nonReentrant`. The first is the EIP-3009 pull in
    `fundWithAuthorization`; the balance is checked after it. The second is the keeper push in `refundExpired`, where a
    failed transfer has to leave the order untouched. The third is the best-effort buyer push in `release` and in a reject:
    status, key and `toSeller` are written first, `toBuyer` (what was actually delivered) after it, and `Released` is emitted
    after the transfers.
11. **Best-effort buyer push.** In `release` and in a reject, the seller's share is pushed strictly (a failure reverts) and the
    buyer's share best-effort. If USDC refuses it (buyer blacklisted, or USDC paused when the seller's share is 0), the call
    succeeds, the amount stays at E, `toBuyer` / `Released.toBuyer` report 0, and only `sweep(T, USDC)` can later move it, to
    the buyer. An out-of-gas failure of the push is not swallowed: when the failed call left less than 1/8 of the gas, the
    whole call reverts (empty revert data), so neither a gas-starving caller nor `eth_estimateGas` can produce a silent skip.
12. **Extra validity rules** (additive, each only rejects Terms that could strand or lock funds): `buyer ∉ {factory, VAULT_IMPL,
    USDC}` and, at registration only, `!USDC.isBlacklisted(buyer)` (`BadTerms(4)`, checked before any EIP-3009 pull);
    `killFeeBps ≤ 5000` (`BadTerms(5)`); `reviewWindow ≤ 14 days` (`BadTerms(9)`). The `isBlacklisted` / `paused` queries fail
    open: a failing or short answer reads as "not blocked", so a USDC without them degrades to the plain transfer outcome.

### Base USDC and EIP-7702 (verified on the fork)

FiatTokenV2_2 verifies EIP-3009 signatures through ERC-1271 for **any signer with code**. That includes a 7702
designator `0xef0100‖impl`. A delegated buyer whose delegate does not implement ERC-1271 therefore cannot use
`fundWithAuthorization`; USDC returns `FiatTokenV2: invalid signature`. That buyer needs the direct rail: `USDC.transfer(E)`
followed by `register`. Our `decideBySig` still accepts its ECDSA signature. A delegate that answers ERC-1271 with the
account's own key works with `fundWithAuthorization`. Anvil's default test accounts are all delegated on Base mainnet
(code `0xef01008a67…`), which is why `Smoke.s.sol` uses a label-derived test key.

## Audit fixes (2026-10-17)

One independent review of commit 37ff0ca. Its PoCs are ported to `test/unit/AuditRegressions.t.sol` and `test/fork/BaseFork.t.sol`
(`test_fork_M1_*`, `test_fork_L1_*`); each asserts the fixed behaviour where the PoC asserted the broken one.

| Finding | Fix | Regression tests |
|---|---|---|
| **M1** keeper path pinned or starved: the window always started at `scanFrom`, so one never-terminal entry (a buyer blacklisted for 0.10 USDC), 20 long-deadline orders or 20 live Studio orders hid every later order, and `refundableCount` kept counting the stuck entry | rotating private cursor over `[scanFrom, length)`; `refundableCount` scans the same window and skips unpayable entries (paused, buyer or E blacklisted); already-blacklisted buyers rejected at registration (`BadTerms(4)`) | `test_M1_*`, `testFuzz_M1_rotationReachesEveryRefundable`, `invariant_keeperRotationReachesEveryRefundable`, `check_keeperCountMatchesRefunds`, fork `test_fork_M1_*` |
| **L1** a failing buyer push (blacklisted buyer; change forced > 0 by a 1-unit donation) reverted `release` / reject, so the seller could never be paid | seller push strict, buyer push best-effort; undelivered change stays at E and is sweepable only to the buyer after terminal; out-of-gas guard | `test_L1_*`, `invariant_exitsAreLive` (handler blacklists buyers), `invariant_toBuyerNeverOverstated`, `check_releasePaysSellerDespiteUnpayableBuyer`, fork `test_fork_L1_*` |
| **L2** no cap on `reviewWindow` (~136-year lock) or `killFeeBps` | `MAX_REVIEW_WINDOW = 14 days` (`BadTerms(9)`), `MAX_KILL_FEE_BPS = 5000` (`BadTerms(5)`); worst-case lock 47 days | `test_L2_*`, `test_register_revert_{reviewWindow,killFee}AboveCap`, `test_register_boundaries`, I9 |
| **Info 1** buyer == factory / VAULT_IMPL / USDC registrable (refund strands funds) | rejected in validation (`BadTerms(4)`) | `test_register_revert_buyerIsProtocolContract`, `test_info1_buyerIsFactoryRejected` |
| **Info 2** `Swept` can be emitted for any token with any reported amount | accepted, documented: indexers read `Swept` as money only when `token == USDC` | `test_info2_sweepOfForeignTokenIsHarmless` |
| **Info 3** K leaks in the calldata of a reverted `release` | operational, see below | — |

### Operating `release` safely (Info 3)

`release(T, K, charge, manifestHash)` carries `K_chain` in calldata, and a reverted transaction still publishes it. A third
party holding K still cannot release (I10), but the buyer would hold the key without the seller being paid. The operator must:

1. **Simulate immediately before sending** (`eth_call` / `eth_estimateGas` against the latest block, same `from`), and send
   only if it succeeds.
2. **Leave margin in the charge.** With SLA decay, `payoutAt` falls every second. Use `charge ≤ payoutAt(T, now + margin)`,
   where the margin covers inclusion latency (for example 60 s on Base), never `payoutAt(T, now)`.
3. **Stay away from window edges.** Do not send an Instant release within the margin of `T.deadline`, nor a Studio release
   before `deliveredAt + reviewWindow` (unless accepted) or within the margin of `deliveredAt + reviewWindow + RELEASE_GRACE`.
   Past the safe window, let the order refund.
4. **Use the estimated gas plus a buffer.** The buyer push is best-effort but cannot be gas-starved, so an under-gassed call
   reverts (and leaks K) instead of skipping the change.

## Invariants → tests

| # | Invariant (frozen §3) | Encoded in |
|---|---|---|
| I1 | Tokens leaving any E go only to T.buyer or T.seller | `invariant_I1_outflowsOnlyToParties` (every Transfer log out of every E is attributed); `check_onlyPartiesReceive`, `check_releasePaysSellerDespiteUnpayableBuyer` (halmos); `test_sweep_*`, `test_refund_*` |
| I2 | Seller paid ≤ T.amount per T | `invariant_I2_sellerPaidAtMostAmount` (ghost ledger == `order().toSeller`); `testFuzz_instantRelease_split` |
| I3 | Seller paid > 0 ⇒ (Released ∧ keccak(key)==keyHash ∧ in time) ∨ (Rejected ∧ fee ≤ killFee) | `invariant_I3_sellerPaidOnlyWithRight` (checked at the moment of each transfer); `check_releaseNeedsPreimage`, `check_rejectFeeBound` (halmos) |
| I4 | At most one terminal state per T; terminal is absorbing | `invariant_I4_terminalAbsorbing`; `check_noDoubleSettle` (halmos); `test_instant_revert_doubleRelease`, `test_cancel_revert_terminal`, `test_refund_revert_terminal` |
| I5 | After terminal, residual / late funds reach only the buyer | `invariant_I5_afterTerminalOnlyBuyer`; `test_sweep_tokenAfterTerminal`, `test_cancel_thenLateFundsSweptToBuyer`, `test_L1_*` (undelivered change swept to the buyer), fork `duplicateFundingThenSweep`, fork `L1_unpayableBuyerCannotBlockSellerPayout` |
| I6 | Factory and VAULT_IMPL never hold tokens | `invariant_I6_factoryAndImplHoldNothing` (USDC, junk ERC-20, ETH); `check_onlyPartiesReceive`; `test_register_revert_buyerIsProtocolContract`, `test_info1_buyerIsFactoryRejected` |
| I7 | Conservation across actors + escrows | `invariant_I7_conservation` (Σ balances == totalSupply; ETH == injected) |
| I8 | No function lets the caller choose a recipient | `invariant_I8_nonPartiesNeverGain` (attacker/operator/keeper never gain; seller never gets non-USDC); `check_onlyPartiesReceive` |
| I9 | No T with amount > MAX_AMOUNT can be registered or pay a seller | `invariant_I9_overCapNeverProgresses` (over-cap, foreign-seller, over-cap kill fee and over-cap review window Terms in the pool); `test_register_revert_amountHigh`, `test_release_revert_invalidTerms`, `test_register_revert_{killFee,reviewWindow}AboveCap`, `test_L2_*` |
| I10 | A third party holding K cannot release | `invariant_I10_thirdPartyCannotRelease` (attacker always holds K); `test_instant_revert_thirdPartyWithKey`; vault `test_vault_onlyFactory` |
| — | Exits stay live (refund/cancel/sweep/release succeed whenever the guards allow; release even when the buyer is blacklisted) | `invariant_exitsAreLive` (the handler blacklists buyers at random); `check_refundAfterDeadline`, `check_releasePaysSellerDespiteUnpayableBuyer` (halmos); `test_L1_*` |
| — | The seller's payout cannot be blocked from the buyer side; `toBuyer` reports only what was delivered | `invariant_toBuyerNeverOverstated`; `test_L1_unpayableBuyerCannotBlockSellerPayout`, `test_L1_rejectPaysKillFeeWhenBuyerUnpayable`; fork `L1_*` |
| — | A best-effort push cannot be gas-starved (63/64 rule, `eth_estimateGas`) | `test_L1_buyerPushCannotBeGasStarved`, `test_L1_keeperRefundCannotBeGasStarved` (600k-gas token), `test_L1_estimateGasMinimumDeliversChange` |
| — | E is codeless or exactly the canonical clone of VAULT_IMPL | `invariant_escrowCodeIsCanonical`; `test_escrow_codelessUntilFirstOutflow_thenCanonicalClone` |
| — | Registry mirrors `Opened`; `scanFrom` only passes terminal entries | `invariant_registryAndScanFrom`; `test_refundExpired_*` |
| — | Keeper liveness: one rotation of `refundExpired(k)` refunds exactly what `refundableCount(max)` counts; `refundExpired(k)` == `refundableCount(k)`; unpayable entries never counted | `invariant_keeperRotationReachesEveryRefundable`; `testFuzz_M1_rotationReachesEveryRefundable`; `check_keeperCountMatchesRefunds` (halmos); `test_M1_*`; fork `M1_*` |
| — | payoutAt monotone non-increasing, within [floor, amount] | `test_payout_exhaustiveWindows` (every second of 7 windows × 12 Terms); `testFuzz_payoutAt_*` (20k runs in `deep`); `check_payoutBounds`, `check_payoutBoundsMonotone` (halmos) |

## Commands

The commands below assume `contracts/` as the working directory and Foundry 1.8.3 on `PATH`.

```bash
git submodule update --init --recursive        # or: forge install (reads foundry.lock)
forge build --sizes src                          # production contracts only (the test Handler exceeds EIP-170 by design)
forge test                                      # unit + fuzz (1k) + invariants (256×64) + vectors; fork suite skips
FOUNDRY_PROFILE=deep forge test                 # fuzz 20k runs, invariants 5000×128
FOUNDRY_PROFILE=ci forge test                   # fuzz 5k, invariants 512×96
forge snapshot --no-match-path 'test/{fork,invariant,halmos}/*' --check   # gas gate (default profile, fixed seed)
forge coverage --no-match-path 'test/{fork,invariant,halmos}/*' --report summary --ir-minimum

# Base fork (real FiatTokenV2_2). Any Base RPC; responses are cached under ~/.foundry/cache/rpc for the pinned block.
BASE_RPC_URL=https://mainnet.base.org forge test --match-path 'test/fork/*' -vv

# Cross-language vectors (reads ../docs/design/vectors/terms-v1.input.json)
forge test --match-path test/Vectors.t.sol      # writes test/vectors/terms-v1.output.json

# Halmos 0.3.3 (local venv, system python untouched):
#   uv venv --python 3.12 ../.tools/halmos-venv && uv pip install --python ../.tools/halmos-venv/bin/python halmos==0.3.3
# halmos.toml selects the contract and build dir; the `halmos` Foundry profile turns off dynamic test linking.
FOUNDRY_PROFILE=halmos ../.tools/halmos-venv/bin/halmos                       # all check_* properties
FOUNDRY_PROFILE=halmos ../.tools/halmos-venv/bin/halmos --function check_releaseNeedsPreimage
```

Halmos notes: it models `gasleft()` as unconstrained, so properties that cross the out-of-gas guard assert liveness only
for paths where the push is not refused. Pass window sizes as concrete per-path values (OZ `Math.min` is branchless, and a
symbolic multiplication leaves the keeper loop unbounded for the solver).

### Deterministic deployment

The factory address depends only on the init code (bytecode plus `abi.encode(USDC, SELLER)`) and the salt
`keccak256("keyframe.escrow.v1")`, deployed through `0x4e59b44847b379578588920cA78FbF26c0B4956C`. It never depends on
the broadcasting account. `Deploy.s.sol` prints the predicted factory and `VAULT_IMPL`, deploys if needed (it is
idempotent), asserts `VAULT_IMPL == CREATE(factory, 1)` and the immutables, and records `deployments/<chainid>.json`
with the factory, vaultImpl, salt, init-code hash and both runtime code hashes. A dry run never writes the file.

```bash
# 1. Simulate against Base (no broadcast): prints the addresses the real deployment will have.
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 SELLER=<studio payout wallet B> \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_RPC_URL"

# 2. Local anvil fork rehearsal (what was verified; see below)
anvil --fork-url "$BASE_RPC_URL" --fork-block-number 52705000 --port 8649
USDC=0x8335…2913 SELLER=<addr> DEPLOYMENT_OUT=deployments/local/anvil-base-fork-8453.json \
  forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8649 --broadcast --unlocked --sender <anvil acct>
FACTORY=<factory> KEYFRAME_SMOKE_LOCAL=1 \
  forge script script/Smoke.s.sol:Smoke --rpc-url http://127.0.0.1:8649 --broadcast --unlocked --sender <operator>

# 3. Mainnet: done by the builder, by hand, only after fork + invariants + Halmos are green (Foundry keystore, never a raw key):
#    forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_RPC_URL" --account deployer --broadcast \
#      --verify --etherscan-api-key "$ETHERSCAN_API_KEY" --chain 8453
```

## Verification results (2026-10-17, after the audit fixes)

| Gate | Result |
|---|---|
| `forge test` (default) | 162 passed, 1 suite skipped (fork, no RPC); invariants 256 runs × 64 depth (16 384 calls), 0 reverts, 15/15 hold |
| `FOUNDRY_PROFILE=ci forge test` | 162 passed; fuzz 5 000 runs; invariants 512 × 96 (49 152 calls), 0 reverts, 15/15 invariants hold |
| `FOUNDRY_PROFILE=deep` fuzz | 12 fuzz properties × 20 000 runs, all pass |
| `FOUNDRY_PROFILE=deep` invariants | time-boxed to 15 min (`FOUNDRY_INVARIANT_TIMEOUT=900`): 1 026 runs × 128 depth = 131 328 calls, 0 reverts, 15/15 hold. The full 5 000-run campaign was not completed in this pass |
| Fork (`BASE_RPC_URL`, block 52 705 000, real FiatTokenV2_2) | 24 / 24 pass (20 existing + 4 audit regressions) |
| Coverage (unit + fuzz + vectors) | factory 100% branches (70/70), 100% functions (39/39), 272/273 lines (the uncounted line is the inline-assembly revert that bubbles the USDC reason in `fundWithAuthorization`; the bubbling tests assert its exact output); vault and TermsLib 100% |
| Vectors | `test/vectors/terms-v1.output.json` is byte-identical to the pre-fix output (input `sha256 364c9af5…`, unchanged) and matches `packages/protocol/test/vectors/terms-v1.output.json` (terms, payoutSamples) |
| Halmos 0.3.3 (yices) | 10 / 11 `check_*` pass: releaseNeedsPreimage, noDoubleSettle (1 534 paths), refundAfterDeadline, rejectFeeBound, payoutBounds, payoutBoundsMonotone, escrowOfMatchesDerivation, reach_releaseSucceeds, and the new releasePaysSellerDespiteUnpayableBuyer and keeperCountMatchesRefunds (fully explored). `check_onlyPartiesReceive` was not completed in this run (skipped after more than 20 min while sharing the CPU with the deep campaign). `check_noDoubleSettle` reports the loop-unrolling warning at bound 2, as it already did at 37ff0ca (1 487 paths) |
| Mutation checks | dropping the rotation, the payable skip, the strict/best-effort split or the out-of-gas guard each fails the regression and/or invariant suites |
| Anvil fork deploy + smoke | CREATE2 address == prediction (`0xEE79…5fCA` for SELLER = anvil #3), `VAULT_IMPL == CREATE(factory, 1)`, runtime code hashes recorded; 0.10 USDC `fundWithAuthorization` → `release` paid the seller and left E as the canonical clone; `MAX_REVIEW_WINDOW()` = 1 209 600, `MAX_KILL_FEE_BPS()` = 5000 on-chain |
| `forge fmt --check`, `forge lint` | clean |

## Gas (Base fork, real USDC, block 52 705 000)

Values are execution gas of the call frame (`snapshots/KeyframeFork.json`); the delta is against commit 37ff0ca (before the
audit fixes). A transaction adds about 21k intrinsic gas plus calldata. Full transactions on the anvil fork measured
218 310 for `fundWithAuthorization` and 205 238 for `release` (that seller started with no USDC, so its balance slot went from
zero to non-zero; the earlier 187 815 was measured against a seller that already held USDC). The deployment transaction used
3 814 866 (was 3 532 334).

| Path | Gas | Δ |
|---|---:|---:|
| `fundWithAuthorization` (EIP-3009 pull + register) | 213 510 | +2 516 |
| `register` (funds already at E) | 146 234 | +4 429 |
| `release` Instant, exact charge (deploys clone) | 205 262 | +347 |
| `release` Instant, with change to buyer (deploys clone) | 253 779 | +370 |
| `release` Instant, buyer blacklisted: seller paid, change stays at E (deploys clone) | 215 289 | new |
| `release` Studio after accept (deploys clone) | 185 497 | +347 |
| `deliver` | 78 151 | 0 |
| `decide(accept)` | 39 460 | −22 |
| `decideBySig(reject)` with kill fee (deploys clone) | 211 082 | +38 |
| `refund` (deploys clone) | 153 072 | −22 |
| `cancel` Open (deploys clone) | 153 404 | −22 |
| `cancel` unfunded, unregistered (no clone) | 93 965 | −22 |
| `sweep` (deploys clone) / (existing clone) | 123 121 / 81 856 | 0 / 0 |
| `refundExpired(20)`, 20 refunds incl. 20 clone deploys | 1 879 959 (≈ 94k per order) | +4 459 |
| `refundExpired(20)` over 20 unpayable entries: first visit (clone deploys) / later visits | 1 314 720 / 455 608 | new |
| `refundExpired` with nothing to do | 28 604 | +83 |

The registration delta is the `isBlacklisted(buyer)` pre-check (one call through the USDC proxy and a cold read of the
buyer's slot; `fundWithAuthorization` pays less because the pull then finds that slot warm). The keeper condition
`refundableCount` is a view: it adds two `isBlacklisted` calls per refundable entry and one `paused` call per invocation.
