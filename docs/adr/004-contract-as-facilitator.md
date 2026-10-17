# ADR-004: Contract-as-facilitator settlement (`fundWithAuthorization`)

- Status: proposed (drafted for the builder's review)
- Date: 2026-10-17
- Area: `contracts/` (`KeyframeEscrowFactory.fundWithAuthorization`, `register`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

An x402 `exact` payment on Base is an EIP-3009 `transferWithAuthorization` signed by the buyer, with `to = payTo = E`.
Normally a facilitator submits it, and the escrow learns about the order only later from logs or from the API. That leaves a window
where E holds funds but the chain does not know the Terms. Keepers then need the API to tell them what to refund,
and a front-runner that settles the authorization first could leave the facilitator's flow in an odd state.

## Decision

The factory acts as the facilitator. `fundWithAuthorization(T, validAfter, validBefore, nonce, signature)`:

1. validates T (`valid(T)` from the frozen spec) and requires it to be unregistered;
2. calls USDC's **bytes-signature overload**
   `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)` with `from = T.buyer`, `to = E`,
   `value = T.amount`. FiatTokenV2_2 handles both ECDSA and ERC-1271 through this one entry point;
3. if that call reverts **and** `authorizationState(T.buyer, nonce)` is already true (the authorization was executed by
   someone else, a front-runner or a second facilitator), it continues. Otherwise it bubbles the USDC revert data unchanged;
4. registers T (status Open, registry entry, `Opened(termsHash, E, buyer, T)` carrying the full Terms). This requires
   `balanceOf(E) ≥ T.amount`, so a nonce spent on some *other* authorization still fails with `Underfunded`.

`register(T)` remains the permissionless path for funds that are already at E, such as the direct `USDC.transfer` rail used by
7702-delegated wallets.

## Consequences

- Payment and Terms publication are atomic in the normal path. Keepers and the plugin work from chain state alone
  (`order()`, `refundableCount`, `Opened`).
- Front-running is harmless. The buyer signs `to = E`, so the funds can only land at E, and the late facilitator call still
  opens the order (fork test `test_fork_frontRunThenRegister`).
- The API must treat `AlreadyRegistered()` as success after checking `order(h).status`.
- One deliberate CEI exception: the USDC pull runs before the order is written, because the balance check has to see the
  pulled funds. It is safe because the token is the validated USDC, which has no hooks, and the function is `nonReentrant`.
- FiatTokenV2_2 routes any signer with code to ERC-1271. That includes 7702 designators, so a delegated EOA whose delegate
  lacks ERC-1271 cannot use this path and must use the direct rail (fork-verified; see ADR-011).
