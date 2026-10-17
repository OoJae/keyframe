# Integration evidence: Base-fork end to end

Run on 2026-10-17 (UTC) from base commit `2ed35d7`. The changes listed under "Bugs found and fixed" are uncommitted;
the lead commits them.

**Result: PASS, 49/49 steps** (final run `20261017T044248Z`, 218.6 s wall time). The whole system ran on a local anvil
fork of Base mainnet with real USDC (FiatTokenV2_2): the real factory deployed with `contracts/script/Deploy.s.sol`,
the API bundle in workerd, the render worker producing real HyperFrames renders, and the built plugin bundle
`plugin/dist/plugin.mjs`. The run found three bugs, two of them product bugs, and all three are fixed and tested.
No frozen surface changed: `tool-catalog.json` is byte-identical. The bundle sha256 changed because of one plugin fix
(see below).

## What runs

| Component | How it runs |
|---|---|
| Chain | `anvil --fork-url https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY --fork-block-number 52710000 --chain-id 8453`, anvil 1.8.3. The clock is synced to wall time with `evm_setNextBlockTimestamp(now)`. |
| Accounts | Fresh `cast wallet new` keys for buyer, seller, operator (= relayer) and deployer. They are plain EOAs (anvil's default accounts are 7702-delegated on Base). ETH comes from `anvil_setBalance`; the buyer gets 60 USDC from Morpho Blue `0xBBBB…FFCb` by impersonation. |
| Contracts | `forge script script/Deploy.s.sol:Deploy --broadcast` (CREATE2 deployer, `SELLER` = the seller key). `DEPLOYMENT_OUT=deployments/local/e2e-fork-8453.json` (gitignored). |
| API | `wrangler dev --local` (wrangler 4.147.0, workerd) with a generated config: `apps/api/wrangler.toml` plus an R2 bucket. Storage is local D1, KV and **R2** (`/health` reports `storage: r2`). Also the relayer Durable Object and `--test-scheduled`. The run's secrets (`KMASTER`, `ACCESS_SECRET`, `WORKER_TOKEN`, `RELAYER_PRIVATE_KEY`) are random and live in a 0600 env file that is deleted at the end of the run. |
| Render worker | `node --env-file=… src/cli.ts serve` in `apps/worker` (Node 24.21.0, HyperFrames 0.8.140, chrome-headless-shell, `BROWSER_GPU=off`), pointed at the local API. |
| Plugin | `plugin/dist/plugin.mjs` over MCP stdio, one fresh process per call (as the sandbox does), with protocol `2026-07-28` `_meta`. Every non-error result is validated with the starter's `scripts/schema.mjs`. |
| PayBox emulation | The driver does what PayBox does with a proposal. For **x402**: unpaid POST to the proposal URL → 402. It checks single v2, `exact`, `eip155:8453`, USDC, `amount ≤ maxAmount`, `resource.url == proposal URL`. Then it signs EIP-3009 with the buyer key (`@x402/core` `x402HTTPClient` + `@x402/evm` `registerExactEvmScheme`, default spend controls), retries with `PAYMENT-SIGNATURE` and captures the 200. For **evm** proposals it sends the transaction from the buyer key. |

The topology is: plugin process → `https://{api,files,rpc-a,rpc-b}.kf.test` → preload host map → (API: `wrangler dev`) /
(files: API `/files`) / (both RPCs: anvil). The API reaches anvil through a pass-through RPC proxy in the driver.
The worker talks to the API over loopback http.

### Local-only settings (and why)

- **https host map** (`apps/api/scripts/e2e/plugin-preload.mjs`, loaded with `--import`, never bundled). The bundle only
  accepts https origins on port 443, so the preload stands in for a hosts-file entry plus TLS. It works like
  `plugin/test/harness/fetch-map.mjs`, but with a map per host. Every unmapped host fails. The API runs with
  `PUBLIC_BASE_URL=https://api.kf.test` and `FILES_BASE_URL=https://files.kf.test`. The plugin env is
  `KEYFRAME_API_BASE=https://api.kf.test`, `KEYFRAME_FILES_BASE=https://files.kf.test` and
  `KEYFRAME_RPC_URLS=https://rpc-a.kf.test,https://rpc-b.kf.test`. The three allowlists are set to the deployed
  factory (+ nonce-1 vault), the seller and the operator. `KEYFRAME_IPFS_GATEWAY=off`.
- **OFAC list** is served locally (20 dummy entries plus one random address used for the 451 check), so screening is
  fresh and fail-closed without GitHub. **`FACILITATOR_FALLBACK_URL=""`**: nothing settles outside the fork. `OPERATOR_ADDRESS` is
  set to the relayer address as a cross-check. Every other var is the production value from `apps/api/wrangler.toml`.
- **The RPC proxy** in front of the API's `RPC_URL` forwards everything. Scenario 6 only uses it to make `release`
  calls fail with a JSON-RPC error, simulating a relayer RPC outage.
- **Plugin clock**: only after scenario 6 advances the fork clock (+1014 s) do the plugin calls get
  `KF_E2E_CLOCK_OFFSET_MS`. That makes the plugin's `Date.now()` match Base time again, as it does in production. Step
  6.4 first shows that, without the offset, the plugin correctly refuses ("Not refundable yet"). The API's (workerd)
  clock cannot be shifted, so the API keeper refunds through the chain-time path (`refundExpired`).

## Commands

```sh
# full e2e (needs: Foundry 1.8.x, ffmpeg, root pnpm install, apps/worker npm ci + browser, plugin built)
scripts/e2e-fork.sh                         # loads ALCHEMY_API_KEY from .env (never printed); Node 24.21.0 from .tools
FORK_BLOCK=52710000 KEEP_STATE=1 E2E_RUN_DIR=$PWD/.e2e/mine scripts/e2e-fork.sh   # options
# artifacts: .e2e/<run>/{report.json, driver.log, anvil.log, wrangler.log, worker.log, plugin-calls.jsonl,
#            deploy.log, deployment.json, health.json, payment-required.json, leak-scan.json}   (.e2e/ is gitignored)

# package suites after the fixes
pnpm -F @keyframe/protocol test
pnpm -F @keyframe/api typecheck && pnpm -F @keyframe/api test && pnpm -F @keyframe/api smoke
(cd plugin && pnpm --silent test && pnpm unit && node scripts/catalog-snapshot.mjs --check && pnpm check:protocol)
(cd apps/worker && npm test)
(cd contracts && forge test)
```

The driver is `apps/api/scripts/e2e-fork.mjs`. Exit code 0 means every step passed and the leak scan found nothing.
At the end it scans every file left in the run directory for each generated secret, the Alchemy key and the fork URL.
The final run checked 17 secrets and found 0 leaks. anvil prints only the fork host, never the key.

## Steps (final run)

| # | Step | Result | Detail |
|---|---|---|---|
| 0.1 | anvil fork at block 52 710 000, clock synced | PASS | chain 8453, skew 0 s |
| 0.2 | fresh keys, ETH, real USDC from impersonated holder | PASS | buyer plain EOA, 60 USDC |
| 0.3 | `Deploy.s.sol` (SELLER = seller key) | PASS | factory `0xE3E3…1b50`, vault `0xC53c…1e5E`, immutables checked |
| 0.4 | API in workerd: configured, R2, sanctions fresh | PASS | operator = relayer key |
| 0.5 | render worker `serve` ready | PASS | |
| 0.6 | bundle lists the 9 frozen tools = `tool-catalog.json` (input schemas byte-equal) | PASS | |
| 0.7 | sanctioned buyer → API 451, `keyframe_quote` isError | PASS | |
| 5.1 | `keyframe_styles` live, countdown available | PASS | 8 s = 1.00 USDC, style `tminus` |
| 5.2 | `keyframe_quote` countdown 9:16 → draft | PASS | 168 ms |
| 5.3 | poll `keyframe_status` → final; 20 checks pass, none warn/skip | PASS | route x402 (plain EOA); `contentHash == manifest_hash` |
| 5.4 | `keyframe_commission` → strict x402 proposal | PASS | POST `/v1/orders/{q}`, `maxAmount = T.amount` |
| 5.5 | PayBox emulation: 402 → EIP-3009 → `PAYMENT-SIGNATURE` → 200 | PASS | 413 ms, funding confirmed |
| 5.6 | paid body has the frozen §7 shape; `PAYMENT-RESPONSE` matches | PASS | |
| 5.7 | `keyframe_verify funding` (paid body) | PASS | verified, KEY PUBLISHED |
| 5.8 | API releases on-chain (operator → `factory.release`, charge = amount, manifest = contentHash) | PASS | 0.613 s after pay, next block |
| 5.9 | `keyframe_verify delivery`: key from `order()`, chunk decrypted, hashes + MP4 header | PASS | verified, 1/1 chunks, 1080×1920, 8000 ms |
| 5.10 | buyer −1 USDC, seller +1 USDC, E = EIP-1167 clone of VAULT_IMPL, Released, `key == HMAC(KMASTER, kf/kchain/v1/q)`, `keccak(key) == keyHash`, `escrowOf == E` | PASS | |
| 5.11 | `keyframe_status` order → KEY PUBLISHED; replayed payment → byte-identical 200, no second charge | PASS | |
| 5.12 | `keyframe_orders` SIWE recovery (buyer signs the message) | PASS | access token recovered |
| 8.1 | worker stopped: draft answers 425 without `PAYMENT-REQUIRED` (10 requests over 5 s: POST/GET/PUT/browser/junk signature); both payment tools refuse | PASS | |
| 8.2 | worker restarted → queued render claimed → final | PASS | 17.0 s |
| 8.3 | final 402 byte-identical ×3 (POST; GET with browser Accept+UA; POST with JSON Accept, curl UA, body) | PASS | body `{}`, `no-store`, sha256 = the plugin probe's |
| 7.1 | `keyframe_commission_direct` → `USDC.transfer(E, amount)` | PASS | |
| 7.2 | buyer sends it | PASS | |
| 7.3 | `keyframe_verify funding` + tx_hash → SEALED (registration pending) | PASS | |
| 7.4 | keeper cron (scheduled handler) registers T, release follows | PASS | `direct_opened=1`, released 0.51 s after the tick |
| 7.5 | `keyframe_verify delivery` (quote_id) | PASS | verified |
| 9.1 | final quote for the race | PASS | |
| 9.2 | a stranger's valid EIP-3009 for that 402 → 409 `payer_mismatch`, `charged:false`, authorization unused | PASS | |
| 9.3 | two concurrent buyer authorizations for one quote → one 200 + one 409 `already_paid` (`charged:false`); charged once; 1 of 2 nonces used | PASS | **failed before fix 1 (500)** |
| 9.4 | two quotes paid concurrently → both 200 through the one relayer DO (nonces 6/7), both released | PASS | |
| 10.1–10.4 | 2 s interval mining: pay → 200 (1.41 s, `funding: pending`), verify, release 3.6 s after pay, delivery verified | PASS | |
| 10.5 | mining paused during payment → 200 `funding: pending`; `keyframe_verify funding` → **partial / NOT SEALED** (`funded: skip`, next `keyframe_status`); mining resumed → sealed and released 4.0 s later → verified | PASS | **failed before fix 2 (verdict "failed")** |
| 11.1 | private countdown: paid body carries `k_buyer`, `sha256(k_buyer) == spec.kBuyerHash` | PASS | |
| 11.2 | delivery verified with `k_buyer`; without it, `k_buyer` check fails | PASS | |
| 12.1 | studio_sting quote final at once (rw 86400, contentHash 0), x402-paid 25 USDC, not auto-released | PASS | |
| 12.2 | Studio CLI delivery (`k_file` job, KFC1 upload) → API relays `deliver` → Delivered; status IN REVIEW | PASS | |
| 12.3 | `keyframe_review` accept: typed data → buyer signs → relayed `decideBySig` | PASS | |
| 12.4 | release after accept, seller +25 USDC, delivery verified (1080×1920, 10 000 ms) | PASS | |
| 6.1 | two quotes with `deadline_minutes: 5` → final | PASS | |
| 6.2 | release blocked (RPC fault), both paid via x402 → Open, not released | PASS | 4 release attempts blocked |
| 6.3 | fork clock +1014 s past both deadlines; `refundableCount(50) = 2` | PASS | |
| 6.4 | `keyframe_refund` D with the plugin clock before the deadline → refuses, no proposal | PASS | |
| 6.5 | `keyframe_refund` D (plugin clock = Base clock) → `refund(T)` proposal (T re-hashes via `factory.hashTerms`); buyer executes → Refunded, 1 USDC back; verify funding → RETURNED | PASS | |
| 6.6 | API keeper cron: tick 1 → `refundExpired` refunds C (sent by the operator key); tick 2 → API orders C and D `returned` | PASS | tick 1 also logs release `TooLate(…)` for C and `BadStatus(4)` for D (simulated, no gas) |
| 6.7 | buyer made whole (balance = before both payments); escrows empty, clone code; `keyframe_status` C → RETURNED | PASS | |

## Fork transactions (final run, chain 8453 fork)

| What | Tx hash |
|---|---|
| buyer funded with USDC (impersonated holder) | `0x529fceb0903d68240ce636f1718f0b7e0ff1b90d0c84ef7355a31e52e926d2b1` |
| factory deploy (CREATE2) | `0xbe5fe20d107166d77f8d02ee96f701f96e02d582815a72d68d022a713a691dae` |
| happy path `fundWithAuthorization` | `0x92669b17e1cb4093fd250d60740f328f49b529e4ba7d1100394eb30915151cc1` |
| happy path `release` | `0x9b932e1c862844afcd98843d03d5548d3be70ae32dc7e6b789ca7104e2909af9` |
| direct rail `USDC.transfer(E)` (buyer) | `0x82201c47f3fba6a392a133170dfd3f67fab8307813e9aabf9b75ff3a2aaca90c` |
| direct rail `register` (keeper) | `0xa59b21fe821908f7099888b079c65f312f1e5b163ff61fb082f5aeb00a5a0bc5` |
| direct rail `release` | `0x7812e1f777e36ffc01c389253979408baa2838a56219177963c23f7ecd3396e6` |
| race winner funding | `0xb6287af3ddfc21aff891011ce9ea12f631a03726228a71b5c86b634ac81b2e32` |
| concurrent pair funding | `0xdf320c39fe62ed46d2d73ab6f6618b54f9053f2088b4b091c867c9e9b1aae595`, `0x2b794a14a434545426d318ca028cf494fd06d64fed606d10a4f6ee3674d3c670` |
| 2 s blocks funding / release | `0x44148c5e7d7a4b50c57911b562ae73cbe1319b13a6ea0cde98d5bb706e135de5` / `0x223bbe18dca8a0bc46c94f38754e7de7abf38b5bbbfabe189101fa87787bcf53` |
| pending-funding payment | `0x2ca0817ebab692b10705776e585ecef5bb0833934985120142f3cf26f2707729` |
| private order funding | `0xbc3a7927c5b78601147665ef76460557580f57d45b0776e1eb882febe13df145` |
| Studio funding / `deliver` / `decideBySig` / `release` | `0x1792237f43c63c6a9d9c655b04fb87f3b615258e7daceea36e99ae335a5ac817` / `0x5edcb0c69d217887539deafbc3461097f66f6fcadfd10302d4bd6c6a3604620e` / `0xa0b3b80fef847d5a542d291dce2bc08e6d951b8c33b9f387e1d6f2ae01b7c6f0` / `0xb8cbd1fc493e503f68ec82f947d85158ec85f2b91694fed9bd4d084b9f6b432b` |
| refund C funding / D funding | `0xb8c9f6db656ab816bfcf6e532f0a2c7c671f34b18a7650254edd0aa8791b1d20` / `0xdbdd435158d38da73458cd55811f7adf20b914ac2b5e3c17bea09fa5015e6c19` |
| D `refund(T)` by the buyer (keyframe_refund proposal) | `0x9eae6680a778e9ee2e0a028d45475b090843f56c261f66bb5b0fdfee5de8ef21` |
| C `refundExpired(20)` by the API keeper | `0x3ba75db294eea6429f4833a26197432f09f4a526ccbb51846724db64747056ed` |

Addresses (fresh per run): buyer `0x6E2c2B558122Ba96133F66BEfcdE4823aEb0344F`, seller `0x3CfBA72CAcfEDd2fAdd99b70a16392b3862B832c`,
operator `0x5b8a7c0532240914DdA0CF947a5EfD8859ee8ce6`, factory `0xE3E324258C8cD186813009A88AD07A8001121b50`,
vault impl `0xC53c44271A6DA7fCc95226025d36f1f6449d1e5E`.

## Timings (final run, builder's Mac, local fork)

| Metric | Value |
|---|---|
| quote → final (`keyframe_quote` call → first `final` from `keyframe_status`) | **16.5 s**. Worker job median 15.1 s (10 jobs, 14.7–15.2 s). The still is uploaded at 2.8 s; `hyperframes render` takes 8.7 s (median); hero SSIM 0.99963 |
| quote → final after a worker restart | 17.0 s |
| pay → 200 (paid request, settlement in workerd via the relayer DO, automine) | **0.41 s** (`funding: confirmed`) |
| pay → released on-chain (automine) | **0.61 s**. The release is in the block after funding |
| pay → 200 / pay → released with 2 s blocks | 1.41 s (`funding: pending`, `RECEIPT_WAIT_MS` 1200) / 3.6 s |
| unmined funding → released once mining resumes | 4.0 s |
| direct rail: keeper tick → released | 0.51 s |
| gas: `fundWithAuthorization` / `release` (receipts) | 215 806 / 204 915 |
| each plugin tool call (fresh process) | 145–220 ms. `keyframe_status` with `wait_s: 6` on a draft returns after about 3.2 s (budget reserve, by design) |

## Bugs found and fixed

1. **API: concurrent payments for one quote → a 500 instead of a 409** ("not charged"). Two different valid
   authorizations from the buyer were sent at the same time. workerd canceled one request:
   `Uncaught Error: The Workers runtime canceled this request because it detected that your Worker's code had hung`.
   That request got a 500 (pre-fix evidence: `.e2e/run3/wrangler.log` lines 204–207). Cause: `viemChainReader` used
   `http(rpcUrl, { batch: { wait: 5 } })`, and viem keeps one batch scheduler per URL for the whole isolate. The
   loser's x402 verification reads were batched onto the winner's fetch. workerd cancels a request whose only pending
   I/O belongs to another request. The money stayed safe (exactly-once held, and the loser was never settled), but
   the client got an unclassified 500 rather than the frozen 409 `charged:false`.
   **Fix:** `apps/api/src/chain.ts:48-52` sets `batch: false`. Regression test: `apps/api/test/chain.test.ts`. It
   fails on the old transport (one batched request) and passes now (separate unbatched requests). After the fix,
   e2e 9.3 shows `200 + 409 already_paid (charged:false)` and 9.4 shows concurrent payments for two quotes through
   the relayer DO.
2. **Plugin: `keyframe_verify funding` reported verdict "failed" for a successful payment whose funding was still
   pending.** ADR-012 and the frozen paid body allow `funding: "pending"`: on Base with 2 s blocks the receipt often
   arrives after `RECEIPT_WAIT_MS`. The plugin's own instructions are: approve, then poll `get_request`, then call
   `keyframe_verify` with the paid response. Followed right after the 200, they produced
   `funded: fail "the escrow holds 0.00 of 1.00 USDC: not (fully) paid"` and verdict `failed`. That invites the
   agent to pay again (pre-fix evidence: `.e2e/run4/driver.log`, FAIL 10.3).
   **Fix:** `plugin/src/tools/verify.ts:155-163`. When the funding tx is known but has no receipt yet, the
   deal is unregistered and the escrow is short, `funded` is now `skip` ("not sealed yet … check again"). The verdict
   becomes `partial` and the envelope stays NOT SEALED; next is `keyframe_status`. A mined transaction that did not
   fund the escrow, or no transaction at all, still fails. This only stops calling an undecided state a failure. It
   is never reported as verified and gates no proposal. Test: `plugin/test/verify.test.ts:78` (fails before the
   fix). E2E 10.5 covers it deterministically.
   **Bundle:** `dist/plugin.mjs` sha256 `c3e5748ef3822298ec2283e0e1e032337a42f0472e44036f3e21d1161925f3e5` →
   **`32689a47fc25814d08125c8d7541c7531cfb4e3368cf9747b44255274c4969cc`** (600 401 bytes, two builds identical,
   starter conformance passed). **`tool-catalog.json` unchanged** (freeze gate: 9 tools, catalog sha256
   `80aa5fe4…7bea2`).
3. **Contracts: stale provenance hash in a committed vector output.** `contracts/test/vectors/terms-v1.output.json`
   carried `inputSha256 0x44ec…` while `docs/design/vectors/terms-v1.input.json` at HEAD hashes to `0x364c…`, which
   `packages/protocol`'s output also records. `forge test` regenerates the file, and the regenerated copy is in the
   working tree. Every terms/payout value is identical; only the provenance field changed.

Harness-only notes (not product bugs): under the Alchemy free tier, anvil forwards `eth_getLogs` for pre-fork blocks
upstream with a 10-block limit, so the driver queries logs from `fork block + 1`. viem surfaces the injected RPC
fault as `InternalRpcError`, which the relayer classifies as `unavailable`. That is correct: nothing was broadcast.

## Observations and open items (not fixed)

- **`refund_tx` stays null** in `GET /v1/orders/{id}` when the API did not send the refund itself. That happens for a
  buyer `refund(T)` (D) and for `refundExpired` (C, which is the API's own keeper tx). Status (`returned`) and
  `to_buyer` are correct, and the plugin reads the truth from Base. To fill it, the keeper could attribute the
  `Refunded(termsHash)` event, or link the `refundExpired` journal entry. Additive, not frozen.
- **Wall clock vs chain clock.** After time travel the API (wall clock) still considers C before its deadline and
  retries `release`. Each retry is simulated and rejected with `TooLate`/`BadStatus`, costing no gas, until
  `refundExpired` closes the order. In production both clocks agree and the API's per-order `refund(T)` path would
  run instead. That path was not exercised here, because workerd's clock cannot be shifted. It is covered by
  `apps/api/test/keeper.test.ts`.
- **`ChainReader.openedTx`** scans `eth_getLogs` over 9000 blocks. That breaks on providers with small log ranges
  (Alchemy free tier: 10). It is only used in the `AlreadyRegistered` recovery path, its failure is caught, and the
  fallback is a zero tx placeholder. Worth a bounded or paged scan before relying on it.
- **Default x402 clients:** the $1 Countdown pays with `@x402/core`'s default spend controls (cap $1). The 25 USDC
  Studio order needs the payer's own cap. The emulation turns the library default off above $1, as PayBox's approval
  of `maxAmount` replaces it.
- **One flaky run of `plugin/test/anvil.test.ts`:** its `beforeAll` timed out at 60 s once in a full `pnpm unit`. It
  passed in isolation (2 s) and in the full re-run (212/212).
- Studio delivery was played by the driver as the Studio CLI (fixture `studio-10s-9x16.m4v`, sealed with the job's
  `k_file`). There is no separate Studio CLI binary in the repo to drive.

## Test suites after the fixes

| Suite | Result |
|---|---|
| `pnpm -F @keyframe/protocol test` | 129/129 pass |
| `pnpm -F @keyframe/api typecheck` | clean |
| `pnpm -F @keyframe/api test` | 66/66 pass (65 + the new transport test) |
| `pnpm -F @keyframe/api smoke` (workerd + local anvil) | SMOKE OK, 24/24 |
| `cd plugin && pnpm --silent test` | starter conformance `passed`, 9 tools, artifact `32689a47…` |
| `cd plugin && pnpm unit` | 212/212 pass (211 + the new pending test). The first full run hit the anvil `beforeAll` timeout above; the re-run passed |
| `node scripts/catalog-snapshot.mjs --check` | matches (9 tools) |
| `pnpm check:protocol` | `src/protocol` matches `packages/protocol/src` (13 files) |
| `cd apps/worker && npm test` | 63/63 pass |
| `cd contracts && forge test` | 139 pass, 1 suite skipped (fork suite without `BASE_RPC_URL`) |
| Biome (changed files) | clean |

## Files added or changed

- `scripts/e2e-fork.sh`: entry point (Node pin, `.env` key loading without echo, `forge build`).
- `apps/api/scripts/e2e-fork.mjs`: the driver (all scenarios, report, redaction, leak scan, cleanup).
- `apps/api/scripts/e2e/plugin-preload.mjs`: e2e-only https host map and clock offset for the plugin process.
- `apps/api/src/chain.ts`, `apps/api/test/chain.test.ts`: fix 1.
- `plugin/src/tools/verify.ts`, `plugin/test/verify.test.ts`: fix 2 (rebuilt `plugin/dist/plugin.mjs`).
- `contracts/test/vectors/terms-v1.output.json`: fix 3 (regenerated).
- `.gitignore`: `.e2e/`.
