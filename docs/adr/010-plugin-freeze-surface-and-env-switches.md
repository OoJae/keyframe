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
  Pre-upload revision after the independent review (2026-10-17): `keyframe_commission` and
  `keyframe_commission_direct` take `{quote_id, buyer, terms_hash}` (all required; `buyer` and `terms_hash` come from
  `keyframe_quote`'s / `keyframe_status`'s `next.input` and bind the payment to the reviewed deal), and
  `keyframe_status` takes an optional `buyer`. These are plugin-only fields: nothing new is sent to the API.
- The text templates: the quote card, the payment texts, and the envelope vocabulary (SEALED / KEY PUBLISHED /
  RETURNED, plus NOT SEALED, IN REVIEW and UNKNOWN). The wording rules are enforced by a test: never
  "PayBox-verified", "audited", "AI video generator" or "first ever".
- Safety bounds:
  - 50 USDC hard cap.
  - A new payment may lock funds for at most 7 days.
  - A new payment's deal has a review window of at most 14 days and a kill fee of at most 50% (the factory's caps).
  - A payment is for exactly the reviewed deal (`terms_hash`) and buyer wallet, and the live 402 lists exactly one
    requirement.
  - Proposal expiry is ≤ min(now + 240 s, quote expiry − 60 s).
  - A quote with < 90 s left is refused.
  - Review Decisions may be valid for at most 7 days; the plugin's own change request for at most 1 h; SIWE messages
    for at most 15 minutes.
  - Refund-family proposals need 2 agreeing Base RPCs.
  - Output: echoed backend records ≤ 32 KiB each, a data result ≤ 200 KiB, numbers safe integers only.
  - `MIN_GAS_WEI` = 2e13.
- Two wire conventions that the backend must follow from now on (any field may be added, none renamed):
  - **IPFS mirror:** a UnixFS directory `{manifest.json, 0.bin, 1.bin, …}`. Its CID is published as
    `content.ipfs_cid` (quote) or `ipfs_cid` (order) and fetched from `{KEYFRAME_IPFS_GATEWAY}/ipfs/{cid}/…`.
  - **Review "changes":** the plugin builds the typed data itself and ignores the backend's: `ChangeRequest(bytes32
    termsHash,uint256 deadline)` under the Keyframe Escrow domain (`Keyframe Escrow` / `1` / 8453 / the order's
    allowlisted factory), with this order's `termsHash` and `deadline = min(now + 1 h, review end)`. The backend must
    verify exactly this type at submit (`apps/api/src/reviews.ts` does). The factory only ever verifies `Decision`,
    so this signature cannot move money. Semantics (Keyframe's API, ADR-019): with no change request, silence until
    the review window ends counts as accept; after one, nothing is released on silence, one revision may be
    delivered, and payment is released only on the buyer's explicit accept: `decideBySig` inside the on-chain
    window, after it (until the order view's `changes.accept_by`) a signed `Decision(accept)` verified off-chain by
    Keyframe. A reject after the window is a full-refund `cancel`; without an accept the USDC is refunded after the
    review window plus the 3-day grace. `keyframe_review` follows the order view: it accepts/rejects after the
    window only while `changes.accept_by` (clamped to review end + grace) is in the future.
  - **Paid-path outcomes (ADR-019):** `charged` may be `"unknown"` (settling: never pay again, poll
    `keyframe_status`); 503 `settlement_recording_delayed` carries `charged: true` and `order_id`; a replay after
    120 s carries `access_token: null`, `k_buyer: null`, `secrets_withheld: true` and a `recover` hint, and the
    plugin points to `keyframe_orders` (SIWE). The plugin never parses paid responses with the strict
    `PaidResponseSchema` (it reads each field only when well-formed), so none of these fail a parse.
  - **429 (`processed: false`, `Retry-After`):** reported as "rate limited, retry after N s".

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
