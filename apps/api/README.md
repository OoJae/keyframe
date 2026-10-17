# @keyframe/api

The Keyframe x402 API on Cloudflare Workers (Hono, D1, KV or R2, a relayer Durable Object and Cron). It quotes
motion-design orders, serves a deterministic x402 402 whose `payTo` is the order's escrow address E, settles
payments through the escrow factory (contract-as-facilitator), and releases the key on-chain once the encrypted
file exists. It also runs the refund keeper.

The wire contract lives in `docs/design/frozen-interfaces.md` (§4–§7), which wins on any conflict. Design
decisions are in ADR-002, 003, 012, 014, 015 and 019 (security hardening) in `docs/adr/`.

## HTTP surface

| Route | What |
|---|---|
| `GET /v1/styles?tier&format` | Catalog: formats, styles, aspects, prices per duration, ETA, params, policy |
| `POST /v1/quotes` | Body = `keyframe_quote` input (product-render-demo §A3). Per-client rate limit → validation → content policy → per-buyer rate limit → OFAC → render-queue caps (per client and total) → keys (§4) → spec (§6) → Terms (§1). Instant: `draft` plus a render job. Studio: `final` |
| `GET /v1/quotes/{q}` | §7 quote object (`draft → final`, `paid`, `expired`, `cancelled`). Additive: `payable`, `terms_final`; drafts also carry `escrow_status: "provisional_do_not_pay"` and a `notice` (their escrow and terms change when the quote turns final) |
| `POST /v1/quotes/{q}/rail` | Additive, best effort: check now for a direct `USDC.transfer` to E. Rate limited per client; at most one late-fund action per quote at a time, none for dust |
| `ALL /v1/orders/{q}` | **x402 resource.** Unpaid: 402, byte-identical per quote. Draft: 425. Paid: 409. Expired or cancelled: 410. Paid request: replay (bound to the exact header) → verify (EIP-3009 only, payer = `from`) → checks (409 payer, 451 OFAC, 503 capacity, 410 expiry) → claim → settle → record → 200 §7 paid body |
| `GET /v1/orders/{o}` | Order status and timeline. With the access token (`Authorization: Bearer …`, or `?token=`): `k_buyer` (private delivery) and private links. Studio orders with a change request carry `changes {requested_at, accept_by, revision, policy}` |
| `GET /v1/orders?buyer=` | Public list: ids and statuses (additive: `watch_url`, `links` once the key is published) |
| `POST /v1/auth/siwe/challenge`, `/verify` | EIP-4361 recovery. Returns orders with fresh `access_token` and `k_buyer` |
| `POST /v1/reviews/{o}/challenge`, `/submit` | Studio review: EIP-712 `Decision` relayed via `decideBySig`, or an off-chain `ChangeRequest` |
| `GET /v1/stats`, `/llms.txt`, `/openapi.json`, `/health` | Discovery and counters |
| `GET /files/*` | Public immutable artifacts (when `FILES_BASE_URL` is not an R2 custom domain). Single `Range` → 206 (iOS media). A browser navigating to `c/{mh}/manifest.json` (`Accept` has `text/html`, not `application/json`) gets a 302 to the order's `/w` page (else the quote's `/q` page), `Vary: Accept`; JSON clients always get the stored bytes |
| `GET /w/{o}` | Watch & download page: reads the key from `factory.order` on two public Base RPCs, decrypts the KFC1 file in the browser, checks every hash, plays it and offers the MP4, plus a receipt. Private orders: `#t=<access_token>` and/or `#kb=<k_buyer>` in the fragment (never sent in a URL) |
| `GET /q/{q}` | Watermarked preview page of a quote (price, deadline, escrow, how to buy, OG tags); only what `GET /v1/quotes/{q}` shows |
| `GET /` | Front door: pitch, protection steps, live counters, what is orderable now, disclosures |
| `/internal/*` | Bearer `WORKER_TOKEN`: the render worker and the Studio CLI (see below) |

Refusals before settlement carry `"charged": false`. Once a settlement may have started, the paid path answers
either the paid body or `"charged": "unknown"` (409 `settlement_in_progress`: retry the same request with the same
payment header, or poll the quote; never sign a second payment), or, when money moved but the order row could not
be written yet, 503 `settlement_recording_delayed` with `"charged": true` and the order id. claim → settle → record
runs inside a promise owned by `waitUntil`, so a client disconnect cannot cancel bookkeeping after money moved; the
keeper adopts any settlement that still falls through (T registered or E funded ⇒ the order row, the same order id
and the paid body are written; nothing at E and the authorization unused ⇒ the quote is reopened; never otherwise).

The replay store is bound to `sha256` of the exact payment header. The stored body is returned in full only within
120 s of settlement (and before the authorization's `validBefore`); later replays return the same body with
`access_token` and `k_buyer` set to `null`, `secrets_withheld: true` and a `recover` hint (SIWE / `keyframe_orders`).
A different header for an already settled `(from, nonce)` gets 409 `authorization_reused`.

Instant order flow: quote (draft) → worker renders and
encrypts → quote turns `final` with `T.contentHash = manifestHash` → 402 → paid → `fundWithAuthorization(T, auth)`
→ `release(T, K_chain, T.amount, manifestHash)`. Studio flow: paid → `deliver(T, manifestHash)` → buyer review →
`release` after accept or the review window (or `refund`).

## Studio review and change requests

`POST /v1/reviews/{o}/challenge` returns EIP-712 typed data; `submit` verifies the buyer's signature and relays
`decideBySig` (accept or reject) inside the on-chain review window (`review_ends_at`). Without a change request,
silence counts as accept: the keeper releases after the review window.

**After a `changes` request Keyframe never releases on silence.** The buyer signs `ChangeRequest(bytes32
termsHash,uint256 deadline)` under the Keyframe Escrow domain (it cannot move money). Then:

- The studio may deliver **one revision**: `POST /internal/studio/orders/{o}/delivery` opens a new delivery job for the
  order (status stays `delivered`; the contract knows one `deliver`, so the revision's manifest and preview are
  recorded off-chain under `changes.revision`). K_chain decrypts both files.
- Payment is released **only on the buyer's explicit accept**: inside the review window via `decideBySig`; after it
  (until `accept_by` = review end + 3 days − 12 min) the signed `Decision(accept=true)` is verified off-chain and the
  operator releases. A reject after the window is answered with `cancel` (everything back to the buyer).
- If the buyer does not accept by review end + grace, the keeper refunds the buyer in full.

The policy text is returned as `policy` in the change-request challenge/submit responses and in the order view.
No release is ever sent within 120 s of the last valid second (Instant: the deadline; Studio: review end + grace),
and `order()` is read before release calldata (which carries K_chain) is built.

## Catalog and templates

Prices, titles and parameter docs live in `src/catalog.ts` (product-render-demo §A2; Countdown is 1.00 per the
build task). For Instant formats, the **styles, hero frames and readiness come from `templates/<id>/template.json`**,
the same files the render worker loads (bundled at build time by `src/templates.ts`). A format is sold only when its
template's status is `reference` or `production` and it declares styles. Otherwise `POST /v1/quotes` answers 422
`format_unavailable`, naming the formats that are available now. Today that is `countdown` (style `tminus`), the
hidden `probe`, and both Studio SKUs. `launch_sting`, `portfolio_pulse` and `kinetic_post` open automatically on the
next deploy after the builder designs them. `chart_moment` also stays off via `FORMATS_DISABLED` until a
market-data snapshot provider exists.

## Layout

```
src/worker.ts            Workers entry: fetch, scheduled (keeper), exports the Relayer DO
src/app.ts               Hono routes (thin)
src/config.ts            vars + secrets → typed Config (problems listed by name; values never logged)
src/quotes/              request schema, content policy, spec/terms assembly, service, §7 view
src/x402/                payment header decoding, x402HTTPResourceServer runtime + canonical adapter, facilitator
src/orders/              paid path, settlement bookkeeping + orphan adoption (settle.ts), post-funding lifecycle,
                         direct rail, status/list, access tokens
src/ratelimit.ts         per-client D1 token buckets (+ optional Cloudflare Rate Limiting binding)
src/redact.ts            error text without RPC URLs, request bodies or key-like tokens
src/internal/jobs.ts     render-worker and Studio delivery API
src/delivery/            K_file derivation, artifact validation and self-verification (KFC1)
src/relayer/             RelayerCore (nonces, simulate-then-send, raw-tx store, reconciliation) + Durable Object
src/chain.ts             read-only viem client (+ read-only signer for the x402 verifier)
src/logs.ts              the one eth_getLogs path: LOGS_RPC_URL windows, RPC_URL 10-block fallback, time-bounded scans
src/sanctions.ts         OFAC SDN ETH list: fetch, validate, cache in D1, fail closed when stale
src/keeper.ts            cron tick
src/db/                  typed D1 queries (every transition is a conditional UPDATE)
migrations/               D1 schema: 0001_init.sql, 0002_hardening.sql (additive columns + rate_buckets)
```

## Configuration

Vars live in `wrangler.toml`, secrets in `wrangler secret put` (locally: `.dev.vars`, see `.dev.vars.example`).

| Name | Kind | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | var | Canonical https origin. Every 402 `resource.url` is built from it, and the plugin's `KEYFRAME_API_BASE` must equal it |
| `FILES_BASE_URL` | var | Optional. Default `PUBLIC_BASE_URL/files`. Set it to the R2 custom domain if you use one (= plugin `KEYFRAME_FILES_BASE`) |
| `FACTORY_ADDRESS`, `SELLER_ADDRESS` | var | Escrow factory and its constructor `SELLER` (payout). `VAULT_IMPL_ADDRESS` defaults to CREATE(factory, 1) |
| `RPC_URL` | var/secret | Base RPC (a secret if it embeds a key) |
| `LOGS_RPC_URL` · `LOGS_MAX_RANGE` 2000 | var | `eth_getLogs` only (see below). Default `https://base-rpc.publicnode.com`; with a local `RPC_URL` (anvil, a fork) the default is `RPC_URL` itself. `""` = `RPC_URL` serves logs too. A secret if it embeds a key. Must serve Base mainnet |
| `USDC_ADDRESS` | var | Default: Base USDC. Override only for local chains |
| `X402_WIRE` | var | `v2` (default) or `v1` |
| `FACILITATOR_FALLBACK_URL` | var | Default PayAI. Used only when the relayer cannot broadcast. `""` disables it |
| `QUOTE_TTL_S` 600 · `DRAFT_TTL_S` 900 · `MIN_RELEASE_MARGIN_S` 300 (≥ 180) · `RECEIPT_WAIT_MS` 1200 | var | Timing. Instant `deadline_minutes × 60` must be ≥ `MIN_RELEASE_MARGIN_S` |
| `STUDIO_REVIEW_S` 86400 (≤ 7 d) · `STUDIO_KILL_FEE_BPS` 0 (≤ 5000) · `STUDIO_MAX_OPEN` 3 · `MAX_INFLIGHT_ORDERS` 20 | var | Studio terms and capacity gate. A kill fee above 5000 is a configuration problem (the factory refuses it) |
| `MAX_QUEUED_RENDERS` 50 · `MAX_QUEUED_RENDERS_PER_CLIENT` 3 · `RATE_LIMITS` (`off` disables) | var | Render-queue caps (per hashed client IP) and the D1 token buckets |
| `RELAYER_TX_PER_HOUR` 120 · `RELAYER_LOW_BALANCE_WEI` 5e14 | var | Relayer DO: non-fund transactions per clock hour (beyond it sends are refused and logged loudly; `fundWithAuthorization` is never refused) and the low-ETH alarm |
| `OFAC_MAX_AGE_S` 7 d · `OFAC_REFRESH_S` 6 h · `OFAC_LIST_URL` | var | Sanctions list (0xB10C ETH list by default) |
| `FORMATS_DISABLED` (`chart_moment`) · `POLICY_DENYLIST` · `QUOTES_PER_BUYER_PER_HOUR` 30 · `MAINTENANCE` | var | Product switches |
| `KMASTER` | secret | ≥ 32 bytes hex. Derives K_chain and K_buyer per quote (§4). Rotating it orphans unreleased keys |
| `RELAYER_PRIVATE_KEY` | secret | Hot operator key (= `T.operator`; the plugin's `KEYFRAME_OPERATORS`). Holds a little Base ETH only |
| `WORKER_TOKEN` | secret | ≥ 32 chars. Bearer token for `/internal/*` |
| `ACCESS_SECRET` | secret | ≥ 32 bytes hex. `access_token = b64url(HMAC(ACCESS_SECRET, "kf/access/v1/" ‖ order_id))` |

Bindings: `DB` (D1), `KV` (KV), optional `FILES` (R2; otherwise KV stores artifacts), `RELAYER` (Durable Object),
optional `RATE_LIMITER` (Workers Rate Limiting, `[[ratelimits]]` in `wrangler.toml`: caps every `/v1` request per
client at the edge, in addition to the D1 token buckets on quotes, `/rail`, paid requests, SIWE and reviews).
If anything required is missing, `/health` reports `configured: false` and quoting or settlement answer 503.

**Log scans.** Free RPC plans cap `eth_getLogs` (Alchemy free tier: at most 10 blocks inclusive, `toBlock -
fromBlock <= 9`), so every log lookup goes through `scanLogs` (`src/logs.ts`). It reads the range from
`LOGS_RPC_URL` in windows of `LOGS_MAX_RANGE` blocks, except the newest 10 blocks, which come from `RPC_URL` (the
client that read `latest`; a load-balanced public node a block or two behind refuses a `toBlock` past its own
head). If the logs RPC fails for any reason, the rest of the range is read from `RPC_URL` in chunks of at most 10
blocks inclusive, capped at 120 requests (1 200 blocks, 40 min of Base) and the caller's time budget (10 s by
default; the keeper's direct-rail phase passes its own deadline). A range it cannot cover is a `LogsRangeError`,
never a partial list. Scans start at a block estimated from a known time (`latest - ceil((now - t) / 2) - 30`,
2 s Base blocks, never below 0):

- direct-rail sender screening (`transfersTo`): `t` = the quote's `created_at` on the API clock. A transfer the
  scan misses leaves the balance unattributed, so screening fails closed (`direct_funds_unattributed`).
- `Opened` / `Released` / `Refunded` / `Cancelled` / `Decided` tx backfill and orphan adoption: `t` = the order's
  on-chain `openedAt` / `finalAt`, against the latest block's timestamp. With no known time: the last 9 000 blocks.
  An `Opened` lookup is skipped when `openedAt` is 0.

The logs RPC is trusted like `RPC_URL` for these reads: screening also requires the logs to account for E's full
balance (read from `RPC_URL`), so a missing log blocks the order, it never clears one.

## Develop and test

```sh
pnpm install                                   # repo root (pnpm 11.11, Node 24.21)
pnpm -F @keyframe/api typecheck                # Node build + the Workers-types portability gate
pnpm -F @keyframe/api test                     # vitest: unit, paid path, Studio, keeper, anvil e2e, plugin contract
pnpm -F @keyframe/api smoke                    # wrangler dev in workerd + local anvil: the real bundle end to end
pnpm -F @keyframe/api build                    # wrangler deploy --dry-run --outdir dist (bundle only)
cp .dev.vars.example .dev.vars && pnpm -F @keyframe/api db:migrate:local && pnpm -F @keyframe/api dev
```

- Unit and API tests run the Hono app with the real migrations on `node:sqlite` (`test/support/d1.ts`), in-memory
  storage, a fake factory that decodes the real calldata, and real x402 clients signing real EIP-3009
  authorizations.
- `test/anvil.e2e.test.ts` needs `anvil` and `forge`. It skips without them, or with `KEYFRAME_E2E=0`. It builds
  the escrow factory from `contracts/src` plus a test USDC (`test/e2e/src/E2E.sol`, installed at the canonical
  USDC address) and runs funding, release, the direct rail and a keeper refund on a local EVM with the real
  `RelayerCore`.
- `test/plugin-contract.e2e.test.ts` runs the plugin's own tool handlers (`plugin/src/tools`) against this API and
  those contracts: quote → status → commission → pay → verify funding/delivery (the file is decrypted by the
  plugin) → SIWE recovery, plus the Studio review flow.
- `scripts/smoke-local.mjs` (`pnpm smoke`, `--no-chain` to skip anvil) runs `wrangler dev --local` with random
  secrets and checks the following in workerd: D1 migrations, KV storage, render-before-pay, the 402 determinism,
  a real x402 payment settled by the relayer DO, release, and Cron.

### Interop against a Base fork (for the integration step)

```sh
anvil --fork-url "$BASE_RPC_URL" --fork-block-number <pinned> --chain-id 8453
# deploy the factory with contracts/script, fund the relayer key with fork ETH, then in apps/api/.dev.vars:
#   RPC_URL=http://127.0.0.1:8545  FACTORY_ADDRESS=0x…  SELLER_ADDRESS=0x…  PUBLIC_BASE_URL=http://localhost:8787
#   (logs then come from the fork too: a local RPC_URL is the LOGS_RPC_URL default)
#   RELAYER_PRIVATE_KEY=<fork-funded key>  (+ KMASTER, ACCESS_SECRET, WORKER_TOKEN)
pnpm -F @keyframe/api db:migrate:local && pnpm -F @keyframe/api dev
# pay with @x402/fetch (ExactEvmScheme client, spendControls off) from a fork account holding real USDC
```

USDC is the real FiatTokenV2_2 on a fork, so no `USDC_ADDRESS` override is needed. The render worker can point
its `API_BASE` at the same dev server.

The repo-root `scripts/e2e-fork.sh` (driver: `apps/api/scripts/e2e-fork.mjs`) automates all of this. It runs the fork, the deploy, this
API in workerd with R2, the render worker and the built plugin over MCP stdio, plus an emulated PayBox. The scenarios
are x402, direct rail, refunds, Studio and determinism. Results and the exact commands are in
`docs/evidence/INTEGRATION.md`.

## Render-worker API (`/internal`, bearer `WORKER_TOKEN`, `X-Worker-Id` on job calls)

| Call | Contract |
|---|---|
| `POST /internal/jobs/claim {worker_id, kinds?}` | 200 job inputs, or 204. The lease is 10 min; renew it with heartbeat |
| `GET /internal/jobs/{id}` | The same inputs again (holder only) |
| `POST {upload.heartbeat} {progress?}` | Renews the lease. 403/404/409 mean the job is no longer yours |
| `PUT {upload.still}` `image/png\|image/webp` ≤ 2 MiB | Watermarked key frame. Its sha256 becomes `spec.keyframe.stillSha256` |
| `PUT {upload.preview}` `video/mp4` ≤ 16 MiB | Watermarked preview |
| `PUT {upload.manifest}` JSON | KFC1 manifest (§5). `ManifestSchema`, `salt == T.salt`, and media must equal the output (±1 frame). Write-once per attempt |
| `PUT {upload.chunk}` (`…/chunks/{i}`) | Ciphertext chunk i. Length, sha256 and AES-GCM decryption are checked, and chunk 0 must be a faststart MP4 |
| `POST {upload.done} {template:{id,version,hash}, renderer:{name,version}, keyframe_at_ms}` | Self-verifies from storage. Instant: the quote turns final. Studio: `deliver` is relayed |
| `POST {upload.failed} {error, retryable}` | Re-queues until `max_attempts` (3). After that an Instant quote is cancelled |

Job inputs carry `template {id, catalog_id, format, style}`, `output {aspect, width, height, duration_s, fps,
hero_ms, faststart}`, the spec `params`, `data_snapshot`, `watermark.text`, `kfc1 {salt, k_file, chunk_size}` and
`upload` paths. `k_file` is the raw AES-256-GCM key for this one file: the worker never sees KMASTER, K_chain or
K_buyer (ADR-017).

The Studio CLI uses `GET /internal/studio/orders` (inbox), `POST /internal/studio/orders/{o}/delivery` (opens a
24 h delivery job, then the same upload calls), and `POST /internal/studio/orders/{o}/cancel` (decline: `cancel(T)`
refunds the buyer). Ops: `POST /internal/sanctions/refresh` and `POST /internal/keeper/run`.

## Deploy (do not run before the factory is deployed and verified)

```sh
cd apps/api
pnpm exec wrangler login
pnpm exec wrangler d1 create keyframe                 # paste database_id into wrangler.toml
pnpm exec wrangler kv namespace create KV             # paste the id into wrangler.toml
pnpm exec wrangler r2 bucket create keyframe-files    # optional: uncomment [[r2_buckets]], set FILES_BASE_URL
pnpm exec wrangler d1 migrations apply keyframe --remote
# vars in wrangler.toml: PUBLIC_BASE_URL, FACTORY_ADDRESS, SELLER_ADDRESS, RPC_URL (or as a secret);
#   LOGS_RPC_URL / LOGS_MAX_RANGE only to override the public logs RPC default (README "Log scans")
openssl rand -hex 32 | pnpm exec wrangler secret put KMASTER
openssl rand -hex 32 | pnpm exec wrangler secret put ACCESS_SECRET
openssl rand -base64 48 | tr -d '\n=/+' | pnpm exec wrangler secret put WORKER_TOKEN
pnpm exec wrangler secret put RELAYER_PRIVATE_KEY     # paste a dedicated hot key (cast wallet new); fund it with ~0.002 ETH
pnpm exec wrangler deploy                             # Workers Paid plan (CPU per request > 10 ms)
# attach the custom domain for PUBLIC_BASE_URL in the dashboard, then:
curl -s "$PUBLIC_BASE_URL/health" | jq '{ok, configured, sanctions, operator}'
curl -s -X POST "$PUBLIC_BASE_URL/internal/sanctions/refresh" -H "authorization: Bearer $WORKER_TOKEN"
```

Then set the plugin's portal variables to match: `KEYFRAME_API_BASE = PUBLIC_BASE_URL`, `KEYFRAME_FILES_BASE =
FILES_BASE_URL`, `KEYFRAME_FACTORIES = [{address, vaultImpl, status:"active"}]`, `KEYFRAME_SELLERS = SELLER_ADDRESS`,
`KEYFRAME_OPERATORS = <relayer address from /health>`. Check the 402 determinism with the curl loop in
verification.md §7.3.

## Security notes

- Secrets are only read from the environment. Logs carry ids, hashes and reasons, never keys, tokens, signatures
  or `k_buyer`. `/health` reports configuration problems as a count.
- The relayer DO only ever sends to `FACTORY_ADDRESS`. Every send is simulated first, so a revert costs no gas and
  nothing is broadcast.
- Funds can only move to `T.buyer` or `T.seller` (contract invariant I1). The API's worst case is a delay, never
  a redirect.
- Content policy (`src/quotes/policy.ts`) runs before quoting, on NFKC-normalised text with invisible characters
  removed and Cyrillic/Greek lookalikes and leetspeak folded, including spelled-out words ("n.a.z.i") and every
  nested string of catalog values and portfolio data; bare domains count as links. Studio briefs also get human
  review.
- Hardening from the 2026-10 review (ADR-019): replay bound to the exact payment header and short-lived; Permit2 /
  mixed payloads refused and the verifier's payer must equal the authorization's `from`; settlement owned by
  `waitUntil` with keeper adoption of orphans; "dropped" only after a consistent read and a confirmation delay, and
  never trusted over `order(termsHash)`; refundExpired only after an `eth_call` shows progress; a per-hour relayer
  transaction budget and a low-ETH alarm; every direct-rail sender screened against OFAC; per-client throttling,
  round-robin render claims and streamed body caps; RPC URLs and keys redacted from logged and stored errors.
