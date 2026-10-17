# Keyframe escrow contracts

Pay-on-delivery escrow for Keyframe orders on Base. Every order is a `Terms` struct. Its escrow address
`E = escrowOf(hashTerms(T))` is a counterfactual EIP-1167 clone: the buyer pays a codeless address that already
encodes the deal. The seller is paid only by publishing the key preimage on-chain in time. Otherwise everything
goes back to the buyer.

The source of truth is [`docs/design/frozen-interfaces.md`](../docs/design/frozen-interfaces.md) §1–§3. These
contracts implement it exactly; the [interpretations](#interpretations-of-the-frozen-spec) below cover cases the
spec leaves open. Status: **unaudited**, per-order cap 50 USDC (ADR-013).

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
src/libraries/TermsLib.sol             EIP-712 typehashes + struct hash, domain separator, CREATE/CREATE2 derivation, payoutAt
test/unit/                             every function, revert path and event (124 tests)
test/fuzz/                             payoutAt properties, hashing and derivation, money splits and timing windows
test/invariant/                        handler (buyers/seller/operator/attacker/keeper) + ghost ledgers, I1–I10
test/fork/BaseFork.t.sol               Base mainnet fork, real USDC, pinned block 52 705 000 (20 tests)
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
  `getLogs`), `registryLength`, plus the public getter `scanFrom()`, which is additive and not in the frozen list.

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
5. **`refundExpired` skips an entry whose transfer fails** (USDC paused, or the buyer blacklisted) instead of reverting
   the batch. That entry stays non-terminal, so `scanFrom` stops in front of it, and `refund(T)` remains available.
6. **`T.token == address(0)`** is treated as native ETH by `refund`/`cancel`/`sweep`. This matters only for
   unregistered Terms, because registration requires `token == USDC`.
7. **`payoutAt` is the frozen integer formula verbatim.** No product can overflow for registrable Terms (amount ≤ 50e6,
   64-bit timestamps). For absurd pure-call inputs (amount above about 2^190) it reverts with an arithmetic panic, as the formula
   implies. TypeScript bigint ports agree on every input that does not revert (vectors, fuzz).
8. **`OrderView.toSeller` / `toBuyer`** record the terminal transition. Later sweeps are reported by `Swept` events.
9. **The constructor** rejects a codeless `usdc` (`BadTerms(1)`) and a zero `seller` (`BadTerms(3)`). This is a deploy-time guard only.
10. **Checks-effects-interactions.** Two calls deliberately interact before writing state. Both target the validated USDC,
    which has no hooks, and both functions are `nonReentrant`. The first is the EIP-3009 pull in
    `fundWithAuthorization`; the balance is checked after it. The second is the keeper push in `refundExpired`, where a
    failed transfer has to leave the order untouched.

### Base USDC and EIP-7702 (verified on the fork)

FiatTokenV2_2 verifies EIP-3009 signatures through ERC-1271 for **any signer with code**. That includes a 7702
designator `0xef0100‖impl`. A delegated buyer whose delegate does not implement ERC-1271 therefore cannot use
`fundWithAuthorization`; USDC returns `FiatTokenV2: invalid signature`. That buyer needs the direct rail: `USDC.transfer(E)`
followed by `register`. Our `decideBySig` still accepts its ECDSA signature. A delegate that answers ERC-1271 with the
account's own key works with `fundWithAuthorization`. Anvil's default test accounts are all delegated on Base mainnet
(code `0xef01008a67…`), which is why `Smoke.s.sol` uses a label-derived test key.

## Invariants → tests

| # | Invariant (frozen §3) | Encoded in |
|---|---|---|
| I1 | Tokens leaving any E go only to T.buyer or T.seller | `invariant_I1_outflowsOnlyToParties` (every Transfer log out of every E is attributed); `check_onlyPartiesReceive` (halmos); `test_sweep_*`, `test_refund_*` |
| I2 | Seller paid ≤ T.amount per T | `invariant_I2_sellerPaidAtMostAmount` (ghost ledger == `order().toSeller`); `testFuzz_instantRelease_split` |
| I3 | Seller paid > 0 ⇒ (Released ∧ keccak(key)==keyHash ∧ in time) ∨ (Rejected ∧ fee ≤ killFee) | `invariant_I3_sellerPaidOnlyWithRight` (checked at the moment of each transfer); `check_releaseNeedsPreimage`, `check_rejectFeeBound` (halmos) |
| I4 | At most one terminal state per T; terminal is absorbing | `invariant_I4_terminalAbsorbing`; `check_noDoubleSettle` (halmos); `test_instant_revert_doubleRelease`, `test_cancel_revert_terminal`, `test_refund_revert_terminal` |
| I5 | After terminal, residual / late funds reach only the buyer | `invariant_I5_afterTerminalOnlyBuyer`; `test_sweep_tokenAfterTerminal`, `test_cancel_thenLateFundsSweptToBuyer`, fork `duplicateFundingThenSweep` |
| I6 | Factory and VAULT_IMPL never hold tokens | `invariant_I6_factoryAndImplHoldNothing` (USDC, junk ERC-20, ETH); `check_onlyPartiesReceive` |
| I7 | Conservation across actors + escrows | `invariant_I7_conservation` (Σ balances == totalSupply; ETH == injected) |
| I8 | No function lets the caller choose a recipient | `invariant_I8_nonPartiesNeverGain` (attacker/operator/keeper never gain; seller never gets non-USDC); `check_onlyPartiesReceive` |
| I9 | No T with amount > MAX_AMOUNT can be registered or pay a seller | `invariant_I9_overCapNeverProgresses` (over-cap and foreign-seller Terms in the pool); `test_register_revert_amountHigh`, `test_release_revert_invalidTerms` |
| I10 | A third party holding K cannot release | `invariant_I10_thirdPartyCannotRelease` (attacker always holds K); `test_instant_revert_thirdPartyWithKey`; vault `test_vault_onlyFactory` |
| — | Exits stay live (refund/cancel/sweep/release succeed whenever the guards allow) | `invariant_exitsAreLive`; `check_refundAfterDeadline` (halmos) |
| — | E is codeless or exactly the canonical clone of VAULT_IMPL | `invariant_escrowCodeIsCanonical`; `test_escrow_codelessUntilFirstOutflow_thenCanonicalClone` |
| — | Registry mirrors `Opened`; `scanFrom` only passes terminal entries | `invariant_registryAndScanFrom`; `test_refundExpired_*` |
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

## Verification results (2026-10-17)

| Gate | Result |
|---|---|
| `forge test` (default) | 139 passed, 1 suite skipped (fork, no RPC); invariants 256 runs × 64 depth, 0 reverts |
| `FOUNDRY_PROFILE=ci forge test` | 139 passed; fuzz 5 000 runs; invariants 512 × 96 (49 152 calls), 13/13 invariants hold |
| `FOUNDRY_PROFILE=deep` fuzz | 11 fuzz properties × 20 000 runs, all pass |
| `FOUNDRY_PROFILE=deep` invariants | 5 000 runs × 128 depth = 640 000 calls, 0 reverts, 13/13 invariants hold (38.6 min) |
| Fork (`BASE_RPC_URL`, block 52 705 000, real FiatTokenV2_2) | 20 / 20 pass |
| Coverage (unit + fuzz + vectors) | factory 100% branches (61/61), 100% functions; vault and TermsLib 100% |
| Vectors | `test/vectors/terms-v1.output.json` is identical to `packages/protocol/test/vectors/terms-v1.output.json` (terms, payoutSamples) and to an independent viem 2.51.3 recomputation |
| Halmos 0.3.3 (yices) | 9 / 9 `check_*` pass: releaseNeedsPreimage, onlyPartiesReceive (63 735 paths), noDoubleSettle, refundAfterDeadline, rejectFeeBound, payoutBounds, payoutBoundsMonotone, escrowOfMatchesDerivation, reach_releaseSucceeds |
| Anvil fork deploy + smoke | CREATE2 address == prediction, `VAULT_IMPL == CREATE(factory, 1)`, runtime code hashes recorded; 0.10 USDC `fundWithAuthorization` → `release` paid the seller and left E as the canonical clone |
| `forge fmt --check`, `forge lint` | clean |

## Gas (Base fork, real USDC, block 52 705 000)

Values are execution gas of the call frame (`snapshots/KeyframeFork.json`). A transaction adds about 21k intrinsic gas plus calldata.
Full transactions on the anvil fork measured 215 774 for `fundWithAuthorization` and 187 815 for `release` (the seller
already held USDC). The deployment transaction used 3 532 334.

| Path | Gas |
|---|---:|
| `fundWithAuthorization` (EIP-3009 pull + register) | 210 994 |
| `register` (funds already at E) | 141 805 |
| `release` Instant, exact charge (deploys clone) | 204 915 |
| `release` Instant, with change to buyer (deploys clone) | 253 409 |
| `release` Studio after accept (deploys clone) | 185 150 |
| `deliver` | 78 151 |
| `decide(accept)` | 39 482 |
| `decideBySig(reject)` with kill fee (deploys clone) | 211 044 |
| `refund` (deploys clone) | 153 094 |
| `cancel` Open (deploys clone) | 153 426 |
| `cancel` unfunded, unregistered (no clone) | 93 987 |
| `sweep` (deploys clone) / (existing clone) | 123 121 / 81 856 |
| `refundExpired(20)`, 20 refunds incl. 20 clone deploys | 1 875 500 (≈ 94k per order) |
| `refundExpired` with nothing to do | 28 521 |
