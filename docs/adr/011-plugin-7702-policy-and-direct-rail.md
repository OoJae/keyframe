# ADR-011: 7702 policy and the direct rail

- Status: proposed (drafted for the builder's review); revisit after spike S10 (a portal variable change, no upload)
- Date: 2026-10-17
- Area: `plugin/` (`src/core/wallet.ts`, `src/tools/commission.ts`, `keyframe_commission_direct`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

An x402 `exact` payment is an EIP-3009 `transferWithAuthorization` signed by the payer. For a plain EOA this is
one gasless approval. An EIP-7702-delegated wallet (code `0xef0100 ‖ delegate`) may fail as an x402 payer, and
whether PayBox auto-undelegates first is **unverified** until spike S10. A direct `USDC.transfer(E, amount)` to the
same escrow works from any wallet that can send a transaction, but it costs a little Base ETH for gas. The
escrow's guarantees are identical either way: funds at `E` can only reach `T.buyer` or `T.seller`.

## Decision

1. **Detection.** `eth_getCode(buyer)` on both RPCs, with the protocol's `detect7702`: `0x` means plain; exactly
   `0xef0100 ‖ 20 bytes` means delegated (the delegate is reported); any other code means contract.
2. **Route** (`keyframe_quote` → `route.kind`, `next.tool`):

   | Wallet | Route |
   |---|---|
   | USDC < price | `fund_first`, with the exact shortfall, naming core `get_buy_link` |
   | plain EOA | `x402` (`keyframe_commission`) |
   | delegated, ETH ≥ 2e13 wei | `direct` (`keyframe_commission_direct`) |
   | delegated, no ETH | `x402`, with the auto-undelegate note; if refused, add a little ETH and use direct |
   | other contract | `direct` if it has gas, else `fund_first` (gas) |
   | unreadable | the primary rail |

3. **`KEYFRAME_7702_POLICY`.** `direct-first` (default) applies the table above. `x402-autoundelegate` keeps
   delegated wallets on x402. That is the right setting if S10 shows PayBox undelegates and signs without a
   problem.
4. **`KEYFRAME_PRIMARY_RAIL=direct`** is plan B, in case PayBox refuses a per-order codeless payee. Every wallet
   then routes to the direct rail, or to `fund_first` for gas.
5. **The direct rail runs the same checks.** `keyframe_commission_direct` re-runs every pre-proposal check,
   including the live 402. It proposes `USDC.transfer(E, T.amount)` with value 0, and its text spells out the raw
   calldata, because PayBox's window shows "to = USDC" and not the escrow. The deal is then registered by anyone
   through the permissionless `register(T)` (normally the backend). `keyframe_verify {mode: "funding", quote_id,
   tx_hash}` proves it from the receipt's `Transfer(buyer → E)` and the escrow balance, and reports "SEALED
   (registration pending)" until `order(h)` is `Open`.

## Consequences

- One approval on either rail; only the direct rail needs ETH, and its text warns when the wallet is short.
- `plugin/test/anvil.test.ts` executes a direct-rail transfer plus `register(T)` against the real factory, then
  refunds it with the plugin's own proposal.
- After S10, set `KEYFRAME_7702_POLICY` (and, if needed, `KEYFRAME_PRIMARY_RAIL`) in the portal. The bundle does not
  change.
