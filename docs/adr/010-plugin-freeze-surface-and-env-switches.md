# ADR-010: Plugin freeze surface and env switches

- Status: proposed (drafted for the builder's review)
- Date: 2026-10-17
- Area: `plugin/` (`src/schemas.ts`, `src/tools/copy.ts`, `src/core/config.ts`, `tool-catalog.json`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

The upload locks Sat 2026-10-17 20:00 EDT. After that, only the portal's network hosts, variables and brokered
secrets can change (requirements.md). Everything the agent sees, and every safety rule, must therefore be right in
the bundle. Every operational lever must instead be an env var whose name is frozen (frozen-interfaces.md §9).

## Decision

**Frozen in the bundle** (snapshotted in `plugin/tool-catalog.json`, CI gate `node scripts/catalog-snapshot.mjs --check`):

- The 9 tools of §8, with their names, numbered titles, descriptions (product-render-demo §A5, adapted where §1–§9
  differ, e.g. "reads the key from the factory's on-chain record"), annotations, and input/output JSON Schemas.
  Inputs have a root `type: object`, are strict, and cap every string. `keyframe_quote.params` is an `anyOf` of 7
  strict per-format objects; `catalog` carries formats added after the lock. Backend-sourced outputs (terms,
  catalog items, order records, typed data) are loose records. The proposal tools return exactly the starter's
  strict schemas, and all their guidance goes in `content[0].text`.
- The text templates: the quote card, the payment texts, and the envelope vocabulary (SEALED / KEY PUBLISHED /
  RETURNED, plus NOT SEALED, IN REVIEW and UNKNOWN). The wording rules are enforced by a test: never
  "PayBox-verified", "audited", "AI video generator" or "first ever".
- Safety bounds:
  - 50 USDC hard cap.
  - A new payment may lock funds for at most 7 days.
  - Proposal expiry is ≤ min(now + 240 s, quote expiry − 60 s).
  - A quote with < 90 s left is refused.
  - Review signatures may be valid for at most 7 days; SIWE messages for at most 15 minutes.
  - `MIN_GAS_WEI` = 2e13.
- Two wire conventions that the backend must follow from now on (any field may be added, none renamed):
  - **IPFS mirror:** a UnixFS directory `{manifest.json, 0.bin, 1.bin, …}`. Its CID is published as
    `content.ipfs_cid` (quote) or `ipfs_cid` (order) and fetched from `{KEYFRAME_IPFS_GATEWAY}/ipfs/{cid}/…`.
  - **Review "changes":** typed data under the Keyframe Escrow domain whose `message.termsHash` is the order's, with
    any `primaryType` except `Decision`. The factory only ever verifies `Decision`, so this signature cannot move
    money.

**Env switches** (names frozen by §9; values editable after the lock; an invalid value fails closed and is
reported by name only, never by value):

| Variable | Default | Semantics |
|---|---|---|
| `KEYFRAME_API_BASE` | `https://api.keyframe.studio` | bare https origin of the API and the x402 resource |
| `KEYFRAME_FILES_BASE` | `https://files.keyframe.studio` | https base of `c/{manifestHash}/…` and stills |
| `KEYFRAME_FACTORIES` | `[]` | `[{address, vaultImpl, status: active\|refund-only}]`; `vaultImpl` must be nonce-1 |
| `KEYFRAME_SELLERS` / `KEYFRAME_OPERATORS` | empty | comma lists; a payment requires `T.seller` / `T.operator` ∈ list |
| `KEYFRAME_RPC_URLS` | `https://mainnet.base.org,https://base-rpc.publicnode.com` | up to 3 https URLs, cross-checked |
| `KEYFRAME_IPFS_GATEWAY` | `https://ipfs.filebase.io` | mirror fallback; `off` disables |
| `KEYFRAME_MAX_AMOUNT` | `50000000` | atomic USDC, clamped to 50 USDC; invalid means 0 (no payments) |
| `KEYFRAME_PRIMARY_RAIL` | `x402` | `direct` = plan B if PayBox refuses per-order payees (ADR-011) |
| `KEYFRAME_7702_POLICY` | `direct-first` | see ADR-011 |
| `KEYFRAME_MAINTENANCE` | `0` | `1` pauses quote + both payment tools; status/verify/refund/review/orders still work; an unreadable value means paused |

`keyframe_verify {mode: "derive"}`, the conformance sample, reads no env, no clock and no network. Its output is a
pure function of its input (tested against vector 0, with a faked clock and a broken env).

**Not implemented.** Some older design notes name `KEYFRAME_PROPOSAL_TTL_S`, `KEYFRAME_TEST_MODE`,
`KEYFRAME_FACTORY_CODEHASH` and a 10th tool `keyframe_terms`. frozen-interfaces.md §8–§9 do not list them, and it
wins: the TTL is the fixed bound above, and derive is a mode of `keyframe_verify`.

## Consequences

- Rotating hosts, the factory (same ABI), the seller and operators, the cap, the rail, the 7702 policy and the
  kill switch needs no new upload.
- Fail-closed defaults mean a freshly uploaded bundle refuses every payment until the portal variables are set.
  This is intended, and the plugin README lists the variables to set.
- Any change to a tool's schema or text shows up as a diff of `tool-catalog.json` (a test checks it against the
  built bundle).
