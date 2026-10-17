# @keyframe/api

The Keyframe x402 API on Cloudflare Workers (Hono, D1, KV or R2, a relayer Durable Object and Cron). It quotes
motion-design orders, serves a deterministic x402 402 whose `payTo` is the order's escrow address E, settles
payments through the escrow factory (contract-as-facilitator), and releases the key on-chain once the encrypted
file exists. It also runs the refund keeper.

The wire contract lives in `docs/design/frozen-interfaces.md` (§4–§7), which wins on any conflict. Design
decisions are in ADR-002, 003, 012, 014 and 015 (`docs/adr/`).

## HTTP surface

| Route | What |
|---|---|
| `GET /v1/styles?tier&format` | Catalog: formats, styles, aspects, prices per duration, ETA, params, policy |
| `POST /v1/quotes` | Body = `keyframe_quote` input (product-render-demo §A3). Validation → content policy → per-buyer rate limit → OFAC → keys (§4) → spec (§6) → Terms (§1). Instant: `draft` plus a render job. Studio: `final` |
| `GET /v1/quotes/{q}` | §7 quote object (`draft → final`, `paid`, `expired`, `cancelled`) |
| `POST /v1/quotes/{q}/rail` | Additive, best effort: check now for a direct `USDC.transfer` to E |
| `ALL /v1/orders/{q}` | **x402 resource.** Unpaid: 402, byte-identical per quote. Draft: 425. Paid: 409. Expired or cancelled: 410. Paid request: replay → verify → checks (409 payer, 451 OFAC, 503 capacity, 410 expiry) → CAS → settle → 200 §7 paid body |
| `GET /v1/orders/{o}?token=` | Order status and timeline. With the access token: `k_buyer` (private delivery) and private links |
| `GET /v1/orders?buyer=` | Public list: ids and statuses |
| `POST /v1/auth/siwe/challenge`, `/verify` | EIP-4361 recovery. Returns orders with fresh `access_token` and `k_buyer` |
| `POST /v1/reviews/{o}/challenge`, `/submit` | Studio review: EIP-712 `Decision` relayed via `decideBySig`, or an off-chain `ChangeRequest` |
| `GET /v1/stats`, `/llms.txt`, `/openapi.json`, `/health` | Discovery and counters |
| `GET /files/*` | Public immutable artifacts (when `FILES_BASE_URL` is not an R2 custom domain) |
| `/internal/*` | Bearer `WORKER_TOKEN`: the render worker and the Studio CLI (see below) |

Refusals before settlement carry `"charged": false`. Instant order flow: quote (draft) → worker renders and
encrypts → quote turns `final` with `T.contentHash = manifestHash` → 402 → paid → `fundWithAuthorization(T, auth)`
→ `release(T, K_chain, T.amount, manifestHash)`. Studio flow: paid → `deliver(T, manifestHash)` → buyer review →
`release` after accept or the review window (or `refund`).

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
src/orders/              paid path, post-funding lifecycle, direct rail, status/list, access tokens
src/internal/jobs.ts     render-worker and Studio delivery API
src/delivery/            K_file derivation, artifact validation and self-verification (KFC1)
src/relayer/             RelayerCore (nonces, simulate-then-send, raw-tx store, reconciliation) + Durable Object
src/chain.ts             read-only viem client (+ read-only signer for the x402 verifier)
src/sanctions.ts         OFAC SDN ETH list: fetch, validate, cache in D1, fail closed when stale
src/keeper.ts            cron tick
src/db/                  typed D1 queries (every transition is a conditional UPDATE)
migrations/0001_init.sql D1 schema
```

## Configuration

Vars live in `wrangler.toml`, secrets in `wrangler secret put` (locally: `.dev.vars`, see `.dev.vars.example`).

| Name | Kind | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | var | Canonical https origin. Every 402 `resource.url` is built from it, and the plugin's `KEYFRAME_API_BASE` must equal it |
| `FILES_BASE_URL` | var | Optional. Default `PUBLIC_BASE_URL/files`. Set it to the R2 custom domain if you use one (= plugin `KEYFRAME_FILES_BASE`) |
| `FACTORY_ADDRESS`, `SELLER_ADDRESS` | var | Escrow factory and its constructor `SELLER` (payout). `VAULT_IMPL_ADDRESS` defaults to CREATE(factory, 1) |
| `RPC_URL` | var/secret | Base RPC (a secret if it embeds a key) |
| `USDC_ADDRESS` | var | Default: Base USDC. Override only for local chains |
| `X402_WIRE` | var | `v2` (default) or `v1` |
| `FACILITATOR_FALLBACK_URL` | var | Default PayAI. Used only when the relayer cannot broadcast. `""` disables it |
| `QUOTE_TTL_S` 600 · `DRAFT_TTL_S` 900 · `MIN_RELEASE_MARGIN_S` 300 · `RECEIPT_WAIT_MS` 1200 | var | Timing |
| `STUDIO_REVIEW_S` 86400 · `STUDIO_KILL_FEE_BPS` 0 · `STUDIO_MAX_OPEN` 3 · `MAX_INFLIGHT_ORDERS` 20 | var | Studio terms and capacity gate |
| `OFAC_MAX_AGE_S` 7 d · `OFAC_REFRESH_S` 6 h · `OFAC_LIST_URL` | var | Sanctions list (0xB10C ETH list by default) |
| `FORMATS_DISABLED` (`chart_moment`) · `POLICY_DENYLIST` · `QUOTES_PER_BUYER_PER_HOUR` 30 · `MAINTENANCE` | var | Product switches |
| `KMASTER` | secret | ≥ 32 bytes hex. Derives K_chain and K_buyer per quote (§4). Rotating it orphans unreleased keys |
| `RELAYER_PRIVATE_KEY` | secret | Hot operator key (= `T.operator`; the plugin's `KEYFRAME_OPERATORS`). Holds a little Base ETH only |
| `WORKER_TOKEN` | secret | ≥ 32 chars. Bearer token for `/internal/*` |
| `ACCESS_SECRET` | secret | ≥ 32 bytes hex. `access_token = b64url(HMAC(ACCESS_SECRET, "kf/access/v1/" ‖ order_id))` |

Bindings: `DB` (D1), `KV` (KV), optional `FILES` (R2; otherwise KV stores artifacts), `RELAYER` (Durable Object).
If anything required is missing, `/health` reports `configured: false` and quoting or settlement answer 503.

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
#   RELAYER_PRIVATE_KEY=<fork-funded key>  (+ KMASTER, ACCESS_SECRET, WORKER_TOKEN)
pnpm -F @keyframe/api db:migrate:local && pnpm -F @keyframe/api dev
# pay with @x402/fetch (ExactEvmScheme client, spendControls off) from a fork account holding real USDC
```

USDC is the real FiatTokenV2_2 on a fork, so no `USDC_ADDRESS` override is needed. The render worker can point
its `API_BASE` at the same dev server.

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
# vars in wrangler.toml: PUBLIC_BASE_URL, FACTORY_ADDRESS, SELLER_ADDRESS, RPC_URL (or as a secret)
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
- Content policy (`src/quotes/policy.ts`) runs before quoting. Studio briefs also get human review.
