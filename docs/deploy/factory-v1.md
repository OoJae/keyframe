# Deployed factory v1: one constant differs from `main`

**Factory** `0xd9d55954366Bb9ce979B992DE7218DAF1d61e561` (Base, block 52,720,605) and **vault implementation**
`0xbFB15A493b081070D1cB9ec51Ce0f3e40005728d` are both verified on Sourcify (`match`). The vault matches `main` exactly.
The factory was compiled from `main` with one line different, in `_tryPush`'s out-of-gas guard:

```diff
-            if (gasleft() < gasBefore / 8) revert();    // main (the reviewed M1 fix)
+            if (gasleft() < gasBefore / 63) revert();   // deployed v1 (an earlier revision of the same fix)
```

Found on 2026-10-17 while verifying the factory on Sourcify: `main` gave `no_match`. A byte-level diff of the runtime code
against a fresh build showed every difference inside an immutable slot except this one constant (`PUSH1 0x3f` instead
of `0x08`). Rebuilding `main` with that line changed reproduces the deployed runtime code exactly, and that is the source
Sourcify verified. Same compiler and settings: solc 0.8.30, cancun, optimizer 10,000 runs, no via-IR, no CBOR metadata.

## What it changes

`_tryPush` is the best-effort payout. It lets a blacklisted or paused buyer not block the seller's payment, or a keeper
batch. A token-level revert is always swallowed. An out-of-gas failure must not be, or a gas-starved call could
"succeed" while skipping the payout. `/ 8` detects running out of gas up to 8 calls deep. `/ 63` detects it only
one call deep: a push that runs out of gas deeper (clone → vault → USDC proxy → implementation) is swallowed as if the
token had refused.

**Funds cannot go anywhere new.** Money at an escrow still reaches only `T.buyer` or `T.seller`. Per call:

| Call | Push | Effect of a gas-starved buyer push on v1 |
|---|---|---|
| `refund(T)`, `sweep` | `_push` (reverts) | none |
| `release` | seller `_push`, buyer remainder `_tryPush` | buyer remainder (non-zero only with SLA decay or overpayment) stays at E; `sweep` sends it to the buyer |
| `cancel`, `decide`/`decideBySig` (Studio) | seller fee `_push`, buyer `_tryPush` | same: buyer share stays at E until `sweep` |
| `refundExpired` (keeper batch) | `_tryPush` | the entry is skipped and stays refundable; `refund(T)` and later batches still work |

Only someone who deliberately sends a call with too little gas can cause any of this. `release` is seller/operator only.

## Mitigations (live)

- The relayer sends every factory call with `max(estimate + 20%, estimate + 150k)` gas
  (`apps/api/src/relayer/core.ts` `gasLimitFor`). Our own calls can't starve a push, even if `estimateGas` settles in
  the swallow window. Base charges for gas used, so the reserve costs nothing.
- The keeper refunds known orders one by one with `refund(T)`, which uses the reverting `_push`. `refundExpired` is only
  the fallback for escrows the database does not know.
- The plugin's `keyframe_refund` can propose `sweep` (to the buyer only), and its on-chain reads include the escrow's
  USDC balance, so a leftover is visible.

## Why v1 stays

Redeploying `main` would give a new factory address. That means another mainnet deployment, an API config switch and
a portal allowlist change, all during judging, to fix a path that only a deliberately gas-starved call can reach, with
no way to move funds to anyone new. The plugin's `KEYFRAME_FACTORIES` allowlist already supports several factories
with a status, so a later v1.1 (`/ 8`) can run alongside v1 without changing the plugin.
