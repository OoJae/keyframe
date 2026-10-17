# Keyframe PayBox plugin

*Hire a motion designer from chat and pay only on delivery.* This is the PayBox marketplace plugin: 9 MCP tools
on the starter v1.0.2 layout, bundled to one `dist/plugin.mjs`. The payment goes to a counterfactual escrow
address (the "sealed envelope"), which is derived from the deal itself. The studio is paid only by publishing the
key to the buyer's file on Base before the deadline; otherwise the money can only go back to the buyer.

The plugin does the proof itself, without trusting Keyframe's server (ADR-009):

- it recomputes the escrow from the terms;
- it checks the live 402 pays exactly that address and amount;
- it checks the allowlists;
- it cross-checks two Base RPCs;
- after delivery, it decrypts the file with the key read from Base.

`docs/design/frozen-interfaces.md` is the specification.

## Tools (frozen surface, `tool-catalog.json`)

| Tool | Kind | What it does |
|---|---|---|
| `keyframe_styles` | data | Live catalog (`GET /v1/styles`); falls back to an embedded snapshot when the API is unreachable |
| `keyframe_quote` | data | `POST /v1/quotes`, then the full independent review, which picks the payment route and returns the quote card |
| `keyframe_commission` | **x402** | Re-checks everything, then `proposeX402` POST `{API}/v1/orders/{quote_id}` with `maxAmount = T.amount` and expiry ≤ min(now+240 s, quote expiry − 60 s) |
| `keyframe_commission_direct` | **evm** | Same checks, then `USDC.transfer(E, amount)` (for 7702-delegated wallets, ADR-011) |
| `keyframe_status` | data | Quote (finalizes drafts) or order progress, plus the envelope state from Base (SEALED / KEY PUBLISHED / RETURNED); `wait_s` ≤ 6 |
| `keyframe_verify` | data | `derive` (offline and pure: **the conformance sample**), `funding`, `delivery` |
| `keyframe_refund` | **evm** | `refund(T)` / `sweep(T, token)` / `decide(T, false)` to the allowlisted factory, only when allowed on-chain right now |
| `keyframe_review` | data | Studio review in two stages: a checked EIP-712 `Decision` for core `request_wallet_sign`, then local signer recovery and relay |
| `keyframe_orders` | data | New-chat recovery in two stages: a checked SIWE message, then local signer recovery and the buyer's orders with access tokens |

Proposal tools return **only** the starter's strict proposal schemas in `structuredContent`; all human guidance goes
in `content[0].text`. Any failed check returns `isError` with **no proposal**.

## Layout

```
src/plugin.ts          registers the 9 tools; no network, env or side effects at load/discovery
src/paybox.ts          starter v1.0.2 (byte-identical)
src/schemas.ts         every zod input/output schema (+ re-exports of the starter proposal schemas)
src/catalog.ts         embedded fallback catalog (static)
src/tools/             one file per tool (+ copy.ts: titles/descriptions, define.ts: registration)
src/core/              config (env + defaults) · net (Budget, bounded fetch) · rpc (2-RPC cross-read) · chain (typed reads)
                       api · probe (live 402) · deal (terms, derivation, allowlists) · quote (independent review)
                       resolve (which deal, from what) · onchain (snapshot) · delivery (KFC1 verify) · still · wallet (routes)
                       typed (EIP-712 guard) · siwe (EIP-4361 guard) · envelope (plain-English states) · views · text · result
src/protocol/          GENERATED copy of packages/protocol/src (do not edit; `pnpm sync:protocol`)
scripts/*.mjs          starter tooling (byte-identical) + catalog-snapshot.mjs (freeze gate)
test/                  vitest suites + harness/ (mock backend/chain/files "World", MCP stdio harness, fetch preload)
```

## Configuration (portal Environment variables; see `.env.example` and ADR-010)

| Variable | Default | Notes |
|---|---|---|
| `KEYFRAME_API_BASE` | `https://api.keyframe.studio` | bare https origin |
| `KEYFRAME_FILES_BASE` | `https://files.keyframe.studio` | `{base}/c/{manifestHash}/{manifest.json, i.bin}` |
| `KEYFRAME_FACTORIES` | `[]` | `[{address, vaultImpl, status}]`; `vaultImpl` must be the nonce-1 CREATE address |
| `KEYFRAME_SELLERS`, `KEYFRAME_OPERATORS` | empty | comma lists |
| `KEYFRAME_RPC_URLS` | `https://mainnet.base.org,https://base-rpc.publicnode.com` | ≤ 3, cross-checked, never echoed |
| `KEYFRAME_IPFS_GATEWAY` | `https://ipfs.filebase.io` | mirror fallback, or `off` |
| `KEYFRAME_MAX_AMOUNT` | `50000000` | clamped to 50 USDC |
| `KEYFRAME_PRIMARY_RAIL` | `x402` | `direct` = plan B |
| `KEYFRAME_7702_POLICY` | `direct-first` | or `x402-autoundelegate` |
| `KEYFRAME_MAINTENANCE` | `0` | `1` pauses quote and payments |

The allowlists default to empty, so **a fresh upload refuses every payment until the factory, seller and
operators are configured**. Network hosts to add in the portal (5 of 16):

- the API host
- the files host
- `mainnet.base.org`
- `base-rpc.publicnode.com`, or Alchemy with a brokered `Authorization: Bearer` header
- the IPFS gateway

## Commands (Node 24.21.0, pnpm 11.11.0)

```sh
export PATH=/Users/oluwademilade/Desktop/paybox/.tools/node-v24.21.0-darwin-arm64/bin:$PATH
pnpm install --frozen-lockfile
pnpm --silent test | jq '{status, artifact, discoveredToolCount}'   # starter: typecheck, 2 identical builds, conformance
pnpm unit                                # tsc over src+test, build, vitest (all suites)
pnpm check:protocol                      # src/protocol == packages/protocol/src (pnpm sync:protocol to update)
node scripts/catalog-snapshot.mjs --check   # tool-catalog.json == the bundle's tools/list (freeze gate)
../node_modules/.bin/biome check .       # lint/format with the repo's Biome (plugin/biome.json)
shasum -a 256 dist/plugin.mjs            # record next to the upload in docs/RELEASES.md
```

## Tests (`pnpm unit`)

- **Vector parity.** `keyframe_verify derive` reproduces the termsHash, vault and escrow of
  `packages/protocol/test/vectors/terms-v1.output.json` for all 5 vectors, plus the payout samples. The sample
  call is pure and deterministic under a faked clock and a broken env.
- **Adversarial backends.** Each of 25 hostile backends gets `isError`, no proposal and a reason, on both payment
  tools: wrong `payTo`, a higher 402 amount, a forged escrow or hash, a non-allowlisted factory, seller or operator,
  a non-USDC token, an amount over the cap, a buyer swap, a spec, salt or deadline forgery, an unbound or
  wrong-resolution file, a tampered still, mixed or duplicate or off-network 402s, and an already-funded escrow.
  Also covered: paid, expired, cancelled, draft and expiring quotes, 404 and malformed quotes, 409, fail-closed
  defaults, maintenance, and slow hosts.
- **Proposal envelopes.** Validated against the starter schemas (zod and Ajv): exact `maxAmount`, URL, method,
  expiry bounds and calldata.
- **Routing.** 7702 detection and routes; the direct rail.
- **Delivery.** Real KFC1 encryption of a real 1080x1920 6 s faststart MP4. A 1-bit tamper, a wrong key, a
  wrong manifest or a swapped file fail closed. Private orders need `k_buyer`. Also covered: the IPFS fallback,
  chunk sampling and budgets.
- **Funding.** 2-RPC agreement, disagreement and outage; the receipt `Transfer` check.
- **Refund, sweep, reject.** Windows enforced with exact times.
- **Review and SIWE guards.** Covered: a USDC permit disguised as a review, a Decision that says the opposite,
  another order, another chain or contract, extra fields, long-lived messages, another site's domain, and extra
  lines.
- **Budgets.** Every tool answers in under 8.5 s when every host hangs for 6 s, and the 402 parser is fuzzed.
- **Secret hygiene.** No key material in the bundle, and no env values or RPC URLs in any output.
- **Frozen tooling.** Starter files byte-identical (sha256 against `.starter-manifest.json`), vendored protocol in
  sync, and the catalog freeze gate.
- **MCP stdio harness.** Spawns the built `dist/plugin.mjs` once per operation, as the sandbox does, against the
  mock World over local HTTP, calls all 9 tools, and validates every result with the starter's own
  `scripts/schema.mjs`.
- **Anvil end to end** (`test/anvil.test.ts`, skipped without anvil or `contracts/out`). Runs on the real
  `KeyframeEscrowFactory` bytecode:
  - the derivation equals the contract's;
  - funding and registration are verified;
  - the refund, sweep and reject proposals execute and pay the buyer;
  - `decideBySig` accepts the plugin's Decision typed data;
  - delivery decrypts with the key the contract published.

## Wording

This README and the tool texts follow the product vocabulary: the sealed envelope, SEALED / KEY PUBLISHED /
RETURNED, and only claims that this plugin itself checked. Never "PayBox-verified", "audited" or "AI video
generator". Contracts are unaudited and orders are capped at 50 USDC.
