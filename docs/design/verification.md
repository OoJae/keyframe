<!-- Source: keyframe-design workflow (wf_54984e8c-060), verification-buildorder agent, 2026-10-17. Reconciled decisions live in docs/design/frozen-interfaces.md, which WINS on any conflict. -->

# Keyframe: verification, risk burn-down and build sequencing (staff-engineer plan)

Scope: how to get the CHAMPION ("Keyframe: pay-on-delivery motion studio") built, proven and submitted, given one hard limit. The plugin bundle freezes at the portal upload lock, while hosts, variables, secrets and the backend can keep changing. The builder works solo (they/them). Workspace: `/Users/oluwademilade/Desktop/paybox` (empty).

---

## 0. Clock, gates and the one hard constraint

The plan is anchored to current time. Times are from `date`: Fri Oct 16 20:45 EDT, which is Sat Oct 17 01:45 WAT (the builder's local zone).

| Gate | Exit condition | EDT | WAT | From now |
|---|---|---|---|---|
| G0 | Upload pipeline green. Unpaid 402 validated by PayBox (S0–S2). | Sat 00:00 | 05:00 | H+3.25 |
| G1 | Interop verdict: live $0.10, latency, amounts, 7702 (S3–S10). | Sat 04:00 | 09:00 | H+7.25 |
| G2 | ABI freeze. Terms encoding, CREATE2 formula, ABI subset and events frozen. Fork tests green. | Sat 05:00 | 10:00 | H+8.25 |
| — | Factory deployed and verified on Base. | Sat 06:00 | 11:00 | H+9.25 |
| — | Rest block. It can move, but never between G2 and G3. | Sat 06:00–11:00 | 11:00–16:00 | — |
| G3 | Plugin RC uploaded, all proposals validated (S11), submitted, Claude.ai E2E green on the real escrow. | Sat 15:00 | 20:00 | H+18.25 |
| G4 | FINAL upload plus **Submit Project**. | Sat 17:00 | 22:00 | H+20.25 |
| — | Internal last-resort upload cutoff. | Sat 19:30 | 00:30 | H+22.75 |
| Lock | Portal upload lock. | Sat 20:00 | Sun 01:00 | H+23.25 |

**Principle.** The plugin is a thin, configuration-driven verifier. Four things freeze at G4: its tool catalog, its protocol with the backend, its interface to the chain, and its verification algorithms. Everything that can be expressed as backend behaviour or portal configuration keeps evolving.

---

## 1. Facts verified for this plan (beyond the brief)

Sources read first-hand:
- requirements.md and skill.md
- starter v1.0.2: `paybox.ts`, `plugin.ts`, `package.json`, `scripts/{conformance,test,schema,report,process}.mjs`, `manifest.json`
- the examples
- docs `llms-full.txt` and the hackathon terms page
- `@x402/{hono,core,evm,fetch}@2.28.0` dist on unpkg
- Halmos source and docs
- Alchemy docs
- the builder's Ripcord repo (KeeperHub workflows)

1. **Agent testing requires Submit Project.** "After submitting for review, your project appears in your PayBox plugin list. Enable it there to test privately."
   - The Test console and Validate transaction work on an upload without submitting.
   - Submission is gated by the MoonPay KYC eligibility badge. **KYC is schedule risk #1.**
2. **Uploads look metered.** The docs say "Configuration edits do not consume upload/submission attempts". The actual count is unknown, so read it in the portal at S0.
3. **Platform quotas.**
   - Validation: 1 active, 30 per hour; each result is validatable once, within 5 minutes.
   - Plugin calls and hosted tests share 1 start per second and 1,000 starts per rolling 24 h. **Monitoring must not go through the plugin.**
4. **Conformance executes the sample call.** It runs in a child process whose env is only `HOME`, `NODE_ENV=production`, `NO_COLOR` and `PATH`. The sample tool must therefore be offline and must not depend on portal variables.
5. **What `pnpm test` does.** Typecheck, two builds that must be byte-identical, then conformance. `checkEnvironment` requires Node major 24 on darwin or linux. Pin 24.21.0 and pnpm 11.11.0.
6. **@x402/hono 2.28.0 ordering** (confirmed in `dist/esm/index.mjs`): `processHTTPRequest` (verify) → `next()` (handler) → if `res.status >= 400`, `cancellationDispatcher.cancel` and no settlement → otherwise `processSettlement`.
7. **@x402/evm exact facilitator settle waits for the receipt** (`waitAndReturnSettleResponse` → `signer.waitForTransactionReceipt`). Default self-facilitation therefore adds about one Base block (~2 s or more) to the paid retry.
8. **@x402/core supports per-order pricing and payee.**
   - `DynamicPayTo` and `DynamicPrice` take `(ctx: HTTPRequestContext) => …`.
   - Route patterns accept `[id]` and `:id`; a pattern with no verb matches every method.
   - Self-facilitation works: `x402Facilitator` implements `verify`, `settle` and `getSupported`, wired with `registerExactEvmScheme(f, {signer: toFacilitatorEvmSigner(client), networks})`.
   - Hooks: `onAfterVerify` can abort, and `onBeforeSettle` can `{skip:true, result}`.
9. **402 hazards in @x402/core.**
   - `resource.url = routeConfig.resource || adapter.getUrl()`, i.e. the request URL.
   - `isWebBrowser` (Accept contains `text/html` AND the UA contains `Mozilla`) switches the response to an HTML paywall body.
   - The emitted PaymentRequired is always `x402Version: 2`: a `PAYMENT-REQUIRED` header, with body `{}`. A v1-only fallback needs our own emitter, which uses v1 network id `"base"` (confirmed in `@x402/evm` v1 constants).
10. **Exact EVM defaults.** Asset transfer method `eip3009`, flow `authorization` (verify before the handler, settle after). Base USDC `extra = {name:"USD Coin", version:"2"}`.
11. **The official x402 client caps payments at $1 by default** (`SpendControls.maxAmountPerPayment`, default `"$1"`).
    - Third-party x402 clients with default settings will refuse orders over $1.
    - The "open 402 for every x402 client" traction offer should therefore include a ≤ $1 tier.
    - Integration tests must raise the cap.
12. **Alchemy accepts the key as `Authorization: Bearer <key>`.** A brokered header works for host `base-mainnet.g.alchemy.com`.
13. **Halmos 0.3.3 flags:** `--contract`, `--function` (default prefix `(check|invariant)_`), `--loop`, `--invariant-depth`, `--solver-timeout-assertion`, `--early-exit`.
14. **KeeperHub** (from the builder's Ripcord exports): Schedule trigger, `web3/read-contract`, `Condition`, and `web3/write-contract` with scalar `functionArgs`. Turnkey gas sponsorship works on Base and covers the fee only.
15. **OFAC ETH addresses:** `0xB10C/ofac-sanctioned-digital-currency-addresses`, `lists` branch. 120 ETH addresses; last commit 2026-10-01.
16. **HyperFrames:** `render --variables-file … --strict-variables`. `--docker` gives byte-identical output. `snapshot --at` produces stills.

---

## 2. (a) Day-1 risk spikes, in strict order

**Ordering logic.** Cheapest and most blocking first:
- upload pipeline, then a PayBox parse of our 402 with no money, then live money;
- latency next, because it shapes the server architecture;
- then amounts (pricing), then 7702 (rails);
- the evm validation, which needs the deployed factory, runs last.

The brief's list is fully covered. S0, S2 and S3 are added to de-risk earlier and to route around a pending KYC.

**Spike payee.** `P_i` is a per-order, codeless, recoverable payee: HD address `i` from `SPIKE_MNEMONIC`, which is a Workers secret.
- It is codeless exactly like a counterfactual CREATE2 escrow, so PayBox cannot tell them apart.
- Funds are recovered without gas in `P_i`: sign an EIP-3009 `transferWithAuthorization` with the HD key and relay it (`tools/sweep-spike.ts`).

### S0 – Prerequisites and gating facts (H+0→H+1, no money)

Steps:
1. **Portal.** Sign in to developer.paybox.sh ("Register with PayBox", the same account as the CLI). Record:
   - the eligibility badge;
   - upload and submission attempt limits;
   - whether the project name and blurb are editable later.
   - If KYC is required, start MoonPay KYC with the same email now, then **Recheck**.
2. **Wallets** (PayBox app, all in one account):
   - A "Keyframe buyer": granted to the Claude.ai connector.
   - B "Keyframe studio": payout wallet, never granted to any agent.
   - C "7702 lab": granted only during S10.
3. **Funding.**
   - A: 12 USDC plus about $1 of ETH on Base. Top up to at least 60 USDC before S9.
   - Relayer R: created with `cast wallet new`; the key lives only as a Workers secret. About 0.002 ETH.
   - Deployer D: `cast wallet import deployer --interactive` (Foundry keystore). About 0.001 ETH.
4. **Accounts:** Cloudflare (Workers, D1, R2, KV), an Alchemy Base app, an Etherscan v2 API key.
5. **Repo.** `git init`. Fetch the 14 starter files into `plugin/`, then verify them (see §7.1):
   ```bash
   curl -s https://developer.paybox.sh/plugin-starter/v1.0.2/manifest.json \
     | jq -r '.files|to_entries[]|"\(.value)  \(.key)"' | shasum -a 256 -c
   ```
   Then run `pnpm install --frozen-lockfile && pnpm test` on the echo sample.

**Pass:** badge state known; attempt budget known; starter green locally; wallets funded.

**Fail / fallback:**
- KYC pending: continue S1–S3, which need no submission, and escalate KYC.
- Attempts at 3 or fewer: S1 uploads an early RC skeleton with the final tool names instead of pure diagnostics.

### S1 – Portal upload of a minimal x402-proposal plugin (H+1→H+2.5, no money)

**Spike server** (`api/`, Hono on Workers, ~150 lines):
- `POST /v1/spike/quotes {buyer, amount}` returns `{quote_id, pay_to: P_i, amount}`, stored in D1.
- `GET /v1/quotes/:id`
- `ALL /v1/orders/[id]` serves x402 through `x402HTTPResourceServer` with `DynamicPayTo` and `DynamicPrice` read from D1.
  - Self-facilitated via `registerExactEvmScheme`; `maxTimeoutSeconds: 300`.
  - A **custom adapter** whose `getAcceptHeader()` always returns `"application/json"`, and a canonical `https://` resource URL. This blocks the HTML-paywall and URL-drift hazards.
  - Paid 200 body: `{order_id, quote_id, pay_to, settlement_tx, received_at}`.
- `GET /v1/diag/blob?bytes=N` returns N deterministic bytes.
- **Instrumentation:** a D1 `http_log` row per request with:
  - ts, method, path, UA, Accept, content-length;
  - payment header name, payload x402Version;
  - sha256 of the `PAYMENT-REQUIRED` value, status, ms.
- **Knobs (env):**
  - `X402_MODE=v2|v1`
  - `PAID_DELAY_MS`: applied before verify. Broadcast is skipped if `c.req.raw.signal.aborted`.
  - `SETTLE_MODE=wait|broadcast`

**Plugin v0.** Use the final names where possible. Add the viem dependency with `pnpm add --save-exact viem@2.51.3` (the version the docs suggest).
- `diag_env` [data, offline; the conformance sample]. Reports:
  - Node and platform;
  - `typeof crypto.subtle`, `AbortSignal.timeout`;
  - **names** (never values) of `KEYFRAME_*` env vars.
- `diag_fetch` [data]: timed GETs of `/v1/diag/blob` at 1, 5 and 10 MB, plus `eth_chainId` through Alchemy (brokered header) and through mainnet.base.org.
- `diag_paid_echo` [data]: input `{paid_response: object}`. Returns canonical-JSON sha256, key list and any string lengths over 64. Used by S7.
- `keyframe_commission` [x402]: GETs the quote, then pre-fetches the 402 (POST, no body). Asserts:
  - a single v2 challenge;
  - exact / `eip155:8453` / USDC;
  - `payTo == quote.pay_to` and `amount == quote.amount`.
  - Then returns `proposeX402({chain:"eip155:8453", url, method:"POST", maxAmount})`.
- `keyframe_commission_direct` [evm]: `USDC.transfer(pay_to, amount)` via `proposeEvm`.

**Portal setup:**
- Name: "Keyframe: hire a motion studio from chat, pay only on delivery" (62 characters).
- Blurb (258 characters): "Hire a motion designer from chat and pay only on delivery. One gasless PayBox tap seals your USDC at an escrow address that is the deal itself: the studio gets paid only by publishing the key to your file before the deadline. Otherwise anyone can refund you."
- Hosts: the API host, `base-mainnet.g.alchemy.com`, `mainnet.base.org`.
- Variable: `KEYFRAME_API_BASE`.
- Secret: host `base-mainnet.g.alchemy.com`, header `Authorization`, value `Bearer <key>`.
- Then: Run checks → Test → Load tools → run each tool.

**Pass:**
- Hosted checks pass and 5 tools load.
- `diag_env` reports Node 24.x, `crypto.subtle` present, and `KEYFRAME_API_BASE` visible.
- The Alchemy call succeeds and the bundle contains no key.
- A 5 MB fetch completes in under 3 s.
- `keyframe_commission` returns a proposal with `expiresAt` ≤ 300 s away.

**Fail / fallback** (each must be decided before G2):

| Symptom | Fallback |
|---|---|
| No WebCrypto | Bundle `@noble/ciphers` + `@noble/hashes`. |
| Env vars not visible | Bundle-pinned defaults plus a server-signed config document; the plugin pins the ed25519 key. |
| Large fetch slow or blocked | Chunked AEAD container (1 MiB chunks, per-chunk hashes); masters ≤ 6 MB. |
| Redirects break | Configure only hosts that never redirect (R2 custom domain; a path-style IPFS gateway). |

### S2 – Unpaid validation: PayBox parses our v2 402 with a per-order codeless payTo (H+2.5→H+3.25, no money)

Steps:
1. curl-create a quote: amount `100000`, buyer A.
2. Test console: `keyframe_commission {quote_id}`.
3. Within 5 minutes, **Validate transaction** with wallet A.
4. Repeat the curl three times (POST and GET) and compare header hashes.

**Pass:**
- The preview shows 0.10 USDC to `P_i`.
- `http_log` captures PayBox's unpaid request(s): method, UA, Accept, whether a body was sent, and how many requests.
- Every 402 header sha256 for the quote is identical across PayBox, the plugin pre-fetch, curl POST and curl GET.

**Fail / fallback:**
1. **Parse error on v2:** set `X402_MODE=v1` (custom emitter: JSON body only, network `"base"`, `maxAmountRequired`, no header), make a **new** quote and Validate again.
2. **Both fail:** Validate the starter's x402 example tool against a known-good Base endpoint from `discover_services`. This separates "our 402" from "PayBox".
3. **Payee specifically rejected:** plan B. Primary rail becomes evm direct (`KEYFRAME_PRIMARY_RAIL=direct`); keep x402 for open clients.

Record the decisions as ADR-002 (URL-keyed orders) and ADR-003 (x402 version).

### S3 – Core `use_service` rehearsal, optional, $0.10 (independent of KYC and submission)

Steps: in Claude.ai with the PayBox connector (A granted), have the agent call `use_service {credential_id:A, url:…/v1/orders/<q>, method:"POST"}`, approve, then poll `get_request`.

**Pass:**
- Success, and a Basescan Transfer A→`P_i` for exactly 100000.
- `output.value.response.body` equals our JSON.
- The log shows the probe and the paid retry, including whether the header was `PAYMENT-SIGNATURE` or `X-PAYMENT`, and the payload version.

This proves PayBox's x402 machinery against our server. It is not the plugin path, so S4 is still required. Skip it if `use_service` is not exposed.

### S4 – Live $0.10 plugin order from Claude.ai, per-order codeless payTo ($0.10)

Pre-conditions: Submit Project with the S1 bundle; PayBox app → Plugins → Unofficial → enable; connector with only A granted.

Steps (fresh chat): "Use my Keyframe plugin to pay test quote `<q>` from my buyer wallet."

Expected sequence: `list_credentials` → `discover_plugins(query:"keyframe")` → `use_plugin(keyframe_commission, {quote_id})` → `pending_approval` → passkey → `get_request` until terminal.

Measure:
- number and timestamps of fetches to `/v1/orders/q`: proposal probe, any approval-time re-fetch, paid retry;
- the approval sheet's payee display (screenshot);
- authorization `validAfter` and `validBefore`;
- time from approval to success;
- the shape of the `get_request` output.

**Pass:**
- Exactly one Transfer A→`P_i` of 100000.
- PayBox got 200, and `get_request` is `success` with service status 200 and our body.
- Exactly one approval.

**Fail / fallback:**
- **Paid but no response visible:** recover through `keyframe_status(quote_id)`, which is already in the design.
- **PayBox retried the paid request:** an idempotency key `(from, nonce)` returns the cached 200. Assert there was no second transaction.
- **payTo refused:** plan B as in S2.

### S5 – v2 vs v1 acceptance matrix (no money)

If v2 passed in S2 and S4, run one Validate with `X402_MODE=v1` on a fresh quote so we know the fallback works. **Never serve mixed responses.** The plugin parser supports both versions either way; that is part of the freeze.

**Pass:** both outcomes recorded, and ADR-003 is final.

### S6 – Deterministic 402 across probe, approval and retry (continuous; formal check at H+4.5)

Steps:
```sql
SELECT quote_id, COUNT(DISTINCT req_sha) FROM http_log WHERE status=402 GROUP BY 1 HAVING COUNT(DISTINCT req_sha)>1;
```
This must return no rows. Also keep a vitest byte snapshot of the 402 for a fixed quote.

**Fail:** decode and diff the variants. The usual culprits are `resource.url` (scheme, host, query, trailing slash), time inside the `description`, and Accept-dependent HTML. Fix with the custom adapter and a canonical resource URL.

### S7 – `get_request` delivers the paid response intact ($0.10)

Steps: one paid 200 body of about 4 KB, containing a 64-hex `k_buyer_test`, nested objects, unicode, and a `checksum` field (sha256 of the canonical rest). Ask the agent to pass the `get_request` output into `diag_paid_echo`.

**Pass:** the checksum matches and nothing is truncated or redacted.

**Fail:** shrink the paid body to IDs only. Deliver `k_buyer` through SIWE-gated `keyframe_orders` instead. The plugin must already support that path, so it is a freeze item.

### S8 – Paid re-fetch latency tolerance (4 × $0.10)

Steps: run S4 with `PAID_DELAY_MS` ∈ {0, 4000, 9000, 20000} and `SETTLE_MODE=wait`, stopping at the first failure. The delay sits before verify, and nothing settles if the client has gone. Record PayBox's terminal status, whether funds moved, and whether PayBox retried.

**Decision rule (ADR-012):**

| Measured tolerance | Settlement mode |
|---|---|
| ≥ 10 s | Wait for the receipt; truthful `PAYMENT-RESPONSE`; p95 ≈ 3 s. |
| 4–10 s | Pre-simulate `fundWithAuthorization` with `eth_call`, broadcast, return 200 plus the tx hash immediately (p95 < 1.2 s); confirm in the background. |
| < 4 s | Same as above, plus warm RPC keep-alive and a Durable Object relayer. |

A timeout after settlement never re-charges, because exactly-once is keyed by quote.

### S9 – $8 and $50 proposal amounts ($58, recoverable)

Steps: top up A to at least 60 USDC. Quote `8000000` and `50000000`, then run `keyframe_commission` from Claude.ai and approve both. Afterwards sweep `P_i` back to A with `pnpm -C tools sweep-spike`.

**Pass:** both reach approval and settle.

**Fail:** record the denial reason.
- **Grant policy:** use `request_account_change` and document it for judges.
- **Plugin amount limit L < 50:** set server config `STUDIO_MAX_PRICE = L`. Larger orders use the direct rail or two milestone orders.

### S10 – EIP-7702-delegated wallet behaviour and direct rail (~$1–2)

Steps:
1. Grant C; `cast code C --rpc-url $BASE` should be `0x`.
2. Have the agent run a tiny gasless PayBox operation with C (for example `request_swap` of 1 USDC → ETH on Base). Then `cast code C`; expect `0xef0100…`, 23 bytes.
3. `keyframe_commission` with C. Observe either:
   - (a) a plain-EOA error, or
   - (b) PayBox's composite undelegate-then-sign window, after which `cast code C` is `0x` again.
4. With C delegated, run `keyframe_commission_direct`. Note whether gas is sponsored or needs ETH.

**Pass:** behaviour documented; `KEYFRAME_7702_POLICY` set (`x402-autoundelegate` or `direct-first`); plugin detection correct.

**Fail / fallback:**
- **Cannot produce a delegated wallet:** mark live 7702 behaviour as unverified, and rely on fork test F5 plus unit test P8.
- **Direct rail needs ETH that C lacks:** the plugin returns the exact ETH shortfall and points to `get_buy_link`.

### S11 – Validate transaction for evm refund and direct proposals (after factory deploy, ~H+10, $0.10)

Steps:
1. Create a builder-only test quote with `deadline = now + 3 min`.
2. Fund it with `keyframe_commission_direct` (or `cast send`; the funding source is irrelevant to a refund simulation).
3. Wait past the deadline.
4. Test console: `keyframe_refund {quote_id}` → Validate with a wallet holding ETH.
5. Run `keyframe_commission_direct` on a fresh final quote → Validate with A.
6. Then execute the refund once through Claude.ai.

**Pass:**
- Both simulations succeed.
- The preview `to` is the factory or USDC, `value 0`, and the calldata equals `cast calldata "refund((…))" …`.
- The real refund lands at A.

**Fail:** reproduce the exact calldata with `cast call --trace`, and fix the encoding against the cross-language vectors (test P3).

---

## 3. (b) Full test matrix

### B1 Plugin (`plugin/`, starter v1.0.2 layout kept verbatim)

| ID | Test | How | Pass |
|---|---|---|---|
| P1 | Starter conformance | `pnpm test` (Node 24.21.0, pnpm 11.11.0) | JSON `status:"passed"`, deterministic double build. Sample `keyframe_terms` is pure and offline. |
| P2 | Catalog freeze | `node scripts/catalog-snapshot.mjs` (tools/list over `dist/plugin.mjs`, reusing the starter's `withProcess`), then `git diff --exit-code tool-catalog.json` | No diff after tag `freeze-1`. CI-enforced. |
| P3 | Cross-language vectors | A Forge test writes `contracts/vectors/terms.json` via `vm.writeJson`; vitest consumes it | termsHash, E and refund/transfer calldata identical for 50 random T. |
| P4 | Deal integrity | unit | `dealHash == keccak256(JCS(deal))`; field and bounds checks. |
| P5 | 402 parser | unit + fast-check fuzz | Never throws uncaught. Mixed v1+v2 → reject. Multiple accepts → pick exactly one exact/`eip155:8453`/USDC, else reject. Wrong network/asset/scheme → reject. |
| P6 | Adversarial backend | vitest with stubbed `fetch` returning hostile data: wrong payTo, higher amount, non-allowlisted seller or factory, buyer mismatch, out-of-bounds deadline, quote status draft/expired/paid, 6 s latency | `isError:true`, **no proposal**, actionable text. |
| P7 | Proposal envelopes | unit against the starter schemas | `expiresAt` ≤ min(now+300 s, quote expiry), whole-second Z; evm `value "0"`; x402 `maxAmount == T.amount`. |
| P8 | 7702 detection | unit | `0x` → plain; `0xef0100`+20 bytes → delegated; other code → contract (refuse x402). |
| P9 | Crypto | Shared vectors with `render/`: HKDF split key, AES-256-GCM container; 1-bit tamper | Decrypt OK; tamper fails closed. |
| P10 | MP4 header | Fixtures from real renders (faststart and not), truncated files | Exact duration, width, height; truncated → "unverifiable", never "OK". |
| P11 | Budgets | Mocked slow hosts | Every tool < 6 s worst case (global `AbortSignal.timeout(8000)`); stdout < 64 KiB. |
| P12 | Secret hygiene | `grep -E 'alchemy\|PRIVATE\|Bearer [A-Za-z0-9]' dist/plugin.mjs` | Empty; outputs never echo env values. |
| P13 | Hosted | Portal checks; Test console on all tools; Validate the 3 proposal tools | All green (S11). |

### B2 Contracts (`contracts/`, Foundry plus Halmos)

| ID | Test | Pass |
|---|---|---|
| C1 | Unit: every function, revert path and event | 100% of branches in `forge coverage` for factory and vault. |
| C2 | Fuzz (`--fuzz-runs 20000`): payout math around `dueAt` and `deadline`, amounts 1..CAP, over- and under-funding | No failures. |
| C3 | Invariants (handler, ghost accounting). Actors: buyer, seller, third party, keeper, relayer. Actions: fundWithAuthorization, raw transfer, register, settle (with or without K, by seller or by others), refund, sweepExpired, warp, donate. | See invariants I1–I10 below the table. |
| C4 | Halmos (`check_*` against a simple mock ERC20, not the FiatToken proxy) | `check_settleOnlyWithPreimageBeforeDeadline`, `check_refundOnlyToBuyer`, `check_noThirdPartyRecipient`, `check_payoutBounded`, `check_singleTerminal` all pass. |
| C5 | Base mainnet fork, real USDC (fund test accounts by `vm.prank`-ing a top USDC holder; avoid stdstore `deal` on FiatToken v2.2's packed balance/blacklist slot) | See fork tests F1–F10 below the table. |
| C6 | Gas | `forge snapshot --check` (feeds the budget). |
| C7 | Deploy | Deterministic CREATE2 address equals the prediction; verified source; `cast code` non-empty. |

C3 invariants:
- **I1** USDC at any E only ever moves to T.buyer or T.seller.
- **I2** Σ seller payouts per T ≤ T.amount.
- **I3** The seller is paid only if K is presented and `keccak(K)==keyHash` at or before the deadline.
- **I4** Each T reaches at most one terminal state.
- **I5** After terminal, all residual and late funds can only reach the buyer.
- **I6** The factory never holds tokens between calls.
- **I7** Conservation: Σ actors + Σ escrows is constant.
- **I8** No function lets the caller choose a recipient.
- **I9** No T with amount > CAP can be registered, funded through the factory, or settled.
- **I10** A third party holding K cannot change the seller's payout from `maxPayout(now)`; only T.seller may choose a lower payout or void.

C5 fork tests:
- **F1** EIP-3009 `transferWithAuthorization` (bytes-signature overload, expected on FiatTokenV2_2; to verify) to a codeless E.
- **F2** `fundWithAuthorization` registers T and emits Funded; E stays codeless.
- **F3** `settle` deploys the vault at exactly `computeAddress(T)`, pays the seller, and returns excess to the buyer.
- **F4** Front-run: a raw USDC authorization lands first, our call reverts, `register(T)` succeeds, and settle still works.
- **F5** A 7702-delegated payer: FiatToken treats it as a contract (ERC-1271 path). Document this; the direct transfer still works.
- **F6** A USDC-blacklisted seller cannot block the buyer's refund.
- **F7** Paused USDC: all paths revert; they recover after unpause.
- **F8** Gas per path.
- **F9** `refund(T)` on an unregistered, funded, expired escrow.
- **F10** Deterministic deployer present on Base (`cast code 0x4e59…956C`).

### B3 Backend / API (`api/`) and local x402 interop

| ID | Test | Pass |
|---|---|---|
| A1 | Unit: pricing, quote state machine (draft→final→paid→settled, or expired / refunded / voided), sanctions list loader (case-insensitive, fail-closed on load error), content policy, KDF and encryption vectors | Green. |
| A2 | 402 byte snapshot for a fixed quote; GET == POST | Identical bytes. |
| A3 | Interop harness: `anvil --fork-url $BASE_RPC_URL`, factory deployed by forge script, API under `wrangler dev`, client = `wrapFetchWithPayment(fetch, x402Client)` with `ExactEvmScheme` client and `spendControls:{maxAmountPerPayment:"$50"}` | Happy path settles via `fundWithAuthorization`; T registered. |
| A4 | Wrong payer (`from ≠ T.buyer`), amount mismatch, expired quote (410), sanctioned buyer (451), at capacity | 402 / 4xx with **no** transaction ("you were not charged"). |
| A5 | Replay of the same payment header | Same cached 200; zero additional transactions. |
| A6 | Second, different authorization for a paid quote | 409; never broadcast. |
| A7 | 10 parallel paid retries | Exactly one settlement tx (D1 conditional `UPDATE … WHERE state='final'` with changes==1; relayer Durable Object serialises nonces). |
| A8 | v1 client (`@x402/evm/exact/v1/client`) with `X402_MODE=v1` | Settles; no header leaks. |
| A9 | Latency on fork | Paid retry p95 < 1.2 s in broadcast mode. |
| A10 (post-lock) | PayAI fallback (relayer disabled) | PayAI settles to E; server `register(T)`; order proceeds. |
| A11 (post-lock, every deploy) | **Frozen-bundle contract test**: run `releases/plugin-final.mjs` (the exact uploaded bytes) via the starter runner against staging | Every tool's fixtures pass. The server may only add fields. |

### B4 Render and delivery (post-lock)

| ID | Test | Pass |
|---|---|---|
| R1 | `npx hyperframes render --docker --strict-variables --variables-file v.json`, per template × sample params | Byte-identical across two runs. |
| R2 | `ffprobe` | Duration, resolution and fps equal the deal spec. |
| R3 | Encrypt → R2 + IPFS pin → sha256s | Plugin P9/P10 succeed on the real artefact. |
| R4 | Watermarked preview and still | Exist before payment (Instant render-before-pay). |
| R5 | Settle transaction | `order(h)` view returns K and the hashes. |
| R6 | SLA | Instant p95 delivery < 3 min from confirmation (or seconds when render-before-pay is used). |

### B5 End-to-end agent tests in Claude.ai (mainnet, recorded in `docs/evidence/EVIDENCE.md`)

| ID | Scenario | Pass |
|---|---|---|
| E1 | Instant happy path, $1–8 | One approval. Funded. Settled (K on-chain). `keyframe_verify` decrypts, all hashes match. "Open file" link plays. |
| E2 | Studio tier, $25–50, 24–72 h | Delivered and verified, or refunded at the deadline. |
| E3 | Direct rail with wallet C | One approval; funds at E; registered; delivered. |
| E4 | Shortfall | `keyframe_quote` returns an exact shortfall; agent calls `get_buy_link` (purchase not completed). |
| E5 | Deadline refund (studio paused) | A keeper refunds with zero taps; A's balance is restored. |
| E6 | Seller void (`settle` payout 0) | Instant full refund. |
| E7 | Keepers down | `keyframe_refund` → one approval → refund lands from A. |
| E8 | Sanctioned address as `buyer` input | Refused at quote; 402 never served; no transaction. |
| E9 | Quote expiry | Commission refused; agent re-quotes. |
| E10 | Duplicate attempt | Plugin refuses a paid quote. A forced overpay to E: excess goes to the buyer at settle. Late funds reach the buyer via `refund(T)`. |
| E11 | Lost context (new chat) | `keyframe_orders` with SIWE via `request_wallet_sign` returns the order and `k_buyer`. |
| E12 | Two wallets granted | Agent passes `wallet_id`; buyer address consistent. |
| E13 | Prompt-robustness suite: 10 phrasings | Correct tool order, one approval, no invented identifiers in ≥ 9/10. **Run before G4; descriptions freeze.** |

### B6 Failure-path rehearsals (each with a runbook in `docs/runbooks/`)

| ID | Rehearsal | Pass |
|---|---|---|
| F-R1 | Deadline refund via Cloudflare keeper only (KeeperHub disabled) | Refund ≤ 2 min after the deadline; tx from the keeper EOA. |
| F-R2 | Deadline refund via KeeperHub only (CF cron disabled) | Refund ≤ 10 min after the deadline (cron `*/5`); tx from the Turnkey wallet. |
| F-R3 | Seller void | Payout 0; full refund. |
| F-R4 | Keeper-down buyer refund | E7. |
| F-R5 | Sanctions refusal | E8 plus an A4 log entry. |
| F-R6 | Shortfall → `get_buy_link` | E4. |
| F-R7 | Quote expiry | E9. |
| F-R8 | Duplicate payment | E10, A5, A6. |
| F-R9 | Relayer out of gas | Verify passes, settle refused, 503 "not charged"; alarm fires; top-up restores. |
| F-R10 | Render box down | At capacity → not charged. Already funded → deadline refund. |
| F-R11 | API down | `keyframe_verify` and `keyframe_refund` still work from chain plus T (the "even if our server vanished" claim). |

### B7 Monitoring (post-lock, outside the plugin quota)

| ID | Monitor | Alert |
|---|---|---|
| M1 | Synthetic paid order: `@x402/fetch` from a dedicated hot wallet, $0.01 "ping" format. Hourly during judging, then every 6 h. | Any stage over SLA → Telegram. |
| M2 | Unpaid 402 probe every 10 min (determinism hash, payTo derivation) | Hash drift or non-402. |
| M3 | Relayer ETH < 0.0005; KeeperHub wallet or credits low | Telegram. |
| M4 | Keeper heartbeats (KV timestamp plus healthchecks ping per run) | Stale > 15 min. |
| M5 | **Overdue escrows**: `expiredCount() > 0` for > 15 min, read by a third, independent scheduler (GitHub Actions) | Page. This outcome metric catches keeper failure. |
| M6 | OFAC list fetch failures, render queue age, R2 / IPFS pin status | Telegram. |

---

## 4. (c) Phased build order (scope unconstrained; freeze guaranteed)

**Phase A – Prerequisites and spike stack (H+0→G0).**
- Entry: none.
- Work: S0–S2.
- Exit: G0 green, or plan B chosen; ADR-002 and ADR-003 drafted.

**Phase B – Interop verdict (→G1) in parallel with contract ABI (→G2).**
- Interop track: S3–S10.
  - Exit G1: every spike passed or has a recorded fallback. ADR-011 (7702 policy), ADR-012 (settle latency mode) and the price caps decided.
- Contract track (from H+1): spec in `docs/design/escrow-contract.md`; then ABI; then C1, C2, short C3; then F1–F4 and F9.
  - Exit G2: `docs/design/frozen-interfaces.md` signed off; vectors generated; fork tests green.
- If G2 slips: the plugin is still finalised against the frozen ABI (interface plus vectors). Mainnet deploy may land after the lock, since factory addresses are an env allowlist.

**Phase C – Deploy and finish the plugin (G2→G3; includes the rest block).**
- Deterministic deploy and verify. Then API v1:
  - real T and E;
  - DynamicPayTo;
  - `onAfterVerify` business checks;
  - contract-as-facilitator settle via the relayer Durable Object;
  - status endpoint;
  - settle-by-script;
  - SIWE and review endpoints (stubs allowed; the HTTP shapes are frozen).
- All 10 plugin tools; P1–P12.
- Upload RC1 → hosted checks → Test console → S11 Validate → Submit → Claude.ai E1 (placeholder master), E5, E7, E9, E13 → fix → RC2.
- Exit G3: green on mainnet with the real escrow; `docs/RELEASES.md` row; tag `rc-N`.

**Phase D – Freeze and submit (G3→G4).**
- Final upload = the RC that passed (identical sha256).
- **Submit Project.** Post-submit smoke (Load tools plus one Validate).
- Tag `plugin-final`; copy `dist/plugin.mjs` to `releases/plugin-final.mjs`.
- Exit: the portal shows the final version submitted. The code is frozen.

**Phase E – Post-lock evolution (days; backend only).**
1. Render pipeline and the five human-designed templates. Instant tier uses **render-before-pay drafts**: the quote goes from draft to final with `contentHash` in T (see §9).
2. Keepers (CF Cron, chain-only; KeeperHub `expiredCount` → `sweepExpired(10)`) and M1–M6.
3. Studio-tier operations and the `keyframe_review` backend.
4. Assurance: full Halmos, deep invariants, threat model, external review request. If a bug is found, redeploy with the **same ABI**, add the new factory to the allowlist, and mark the old one `refund-only`.
5. MIT package `packages/x402-escrow`, `llms.txt`, OpenAPI, the open 402 including a ≤ $1 tier (default client cap), single-URL order form, on-chain counter.
6. Film (75–90 s, the builder's voice) and X thread.
7. Guardrails: A11 on every deploy; `KEYFRAME_MAINTENANCE` kill switch; API changes additive only.

**Demo-video timing is unverified.** If the X video must be posted before 20:00 EDT, record a 60 s proof cut during the G3 E2E run and post it by 19:45 EDT; the polished film follows. Confirm with the organisers.

### Freeze manifest (what must be final at G4, and what evolves)

**Frozen in the bundle:**
- **10 tools.** Names, titles, descriptions (agent guidance naming the core tools `get_request`, `get_buy_link`, `request_wallet_sign`, `wallet_id`), JSON Schemas, annotations. Snapshot hash in `tool-catalog.json`.
  - `keyframe_styles`, `keyframe_quote` (inputs include optional `from_quote_id` and an `options` record so two-phase quoting can arrive later), `keyframe_commission` [x402], `keyframe_commission_direct` [evm], `keyframe_status`, `keyframe_verify`, `keyframe_refund` [evm], `keyframe_orders` (SIWE), `keyframe_review` (EIP-712 relay), `keyframe_terms` (offline derivation; conformance sample).
- **Terms JSON and struct.** Proposal for G2: `{buyer, seller, amount, dueAt, deadline, keyHash, dealHash, contentHash, salt}`.
  - `termsHash` encoding.
  - `E = CREATE2(factory, termsHash, vaultInitCodeHash)`.
  - `maxPayout` formula.
- **Factory ABI subset used by the plugin:** `refund(Terms)`, `order(bytes32)` view returning state, buyer, deadline, payout, K, ciphertext/plaintext hashes, settledAt; event signatures. **No `eth_getLogs` dependency**, so free-tier log-range limits are moot.
- **Plugin↔API protocol v1:**
  - `GET /v1/styles`
  - `POST /v1/quotes`, `GET /v1/quotes/{id}`
  - `ALL /v1/orders/{quote_id}`
  - `GET /v1/orders/{id}/status`
  - `POST /v1/auth/siwe/{challenge,orders}`
  - `POST /v1/reviews/{challenge,submit}`
  - Parsed tolerantly with zod `.passthrough()`.
- **Crypto and format:** JCS canonical deal JSON; HKDF-SHA256 split key `(K_chain‖K_buyer, salt=termsHash, info="keyframe/v1/file")`; AES-256-GCM container v1; sha256 content hashes; MP4 header checks.
- **Parsers:** v1 and v2 402 (single version; exact / Base / USDC / payTo==E / amount==T.amount).
- **Safety bounds:** hard cap $50; deadline window 10 min–7 days; chain 8453; seller and factory allowlist check.
- **Env-var names and semantics:**
  - `KEYFRAME_API_BASE`, `KEYFRAME_RPC_URLS`, `KEYFRAME_FACTORIES` (`[{address, initCodeHash, status}]`)
  - `KEYFRAME_SELLERS`, `KEYFRAME_MAX_AMOUNT` (≤ hard cap)
  - `KEYFRAME_PRIMARY_RAIL`, `KEYFRAME_7702_POLICY`
  - `KEYFRAME_PROPOSAL_TTL_S` (≤ 300)
  - `KEYFRAME_MAINTENANCE` (money tools disabled; verify and refund still work)
  - `KEYFRAME_TEST_MODE` (local only)

**Evolves after the lock (server and portal):**
- Prices, catalog, templates and formats (params validated server-side against per-style schemas).
- Card copy, draft/final quoting, render pipeline, SLA policy within the bounds.
- x402 version flag; facilitator choice (self or PayAI).
- Keepers, monitoring, OFAC and content policy.
- Storage and RPC hosts and secrets.
- Factory redeploys with the same ABI; seller rotation via the allowlist.
- Maintenance switch; the open 402 for every x402 client; traction surfaces.

---

## 5. (d) Budget ledger (≤ ~$100) and accounts

| Item | Est. cost | Recoverable | Notes |
|---|---|---|---|
| USDC float in A (covers the $50 probe and Studio demo) | $55 | **Yes** | Cycles A → E → B (studio) or back to A; spike payees swept back gaslessly. |
| ETH on Base: relayer $4, deployer $2, A $1, C $1, keeper EOA $1 | $9 | Mostly | Actual burn is about $1–3 at Base fees (contract deploy < $0.50; ~250k gas per order ≈ < $0.01). |
| On-ramp fees (only if buying via MoonPay) | $0–4 | No | Prefer moving the builder's existing Base USDC/ETH. |
| Domain (optional; `*.workers.dev` works for spikes) | $10–15 | No | |
| Cloudflare Workers Paid (if Free's per-request CPU limit trips on signature checks; to verify) | $5 | No | |
| Render box: small VPS, 2–3 vCPU, ~1 month | $5–8 | No | An always-on 2 vCPU on Railway's usage pricing would blow the budget. Avoid it. |
| Synthetic orders (gas) through judging | ~$2 | No | USDC recycled. |
| Free tiers: Alchemy, Etherscan v2, PayAI, KeeperHub gas station, GitHub, X, Telegram bot, healthchecks.io, Filebase/Pinata IPFS | $0 | — | |
| Contingency | ~$8 | — | |
| **Peak outlay ≈ $100.** Irreversible ≈ $25–40; recoverable ≈ $60. | | | |

**Accounts.** All are individual; no KYB anywhere.

| Account | Why | Needed by |
|---|---|---|
| PayBox, plus MoonPay KYC with the same email | Developer portal, wallets A/B/C, Claude.ai connector, submission | S0 |
| Cloudflare (Workers, D1, R2, KV, DO, Cron; Registrar optional) | API, 402, relayer DO, keeper #1, files | S1 |
| Alchemy (Base mainnet) | Server RPC; plugin RPC via brokered header | S1 |
| Etherscan v2 API key | `forge … --verify` on Base | G2 |
| VPS provider (or Railway, if within budget) | Pre-warmed HyperFrames render box | Phase E |
| KeeperHub (existing org; Turnkey EOA on Base) | Keeper #2 | Phase E |
| PayAI facilitator (no account; keyless) | Settlement fallback | Phase E |
| IPFS pinning (Filebase or Pinata free tier) | Durable content-addressed ciphertext | Phase E |
| GitHub (public repo), X (the builder's or Ripcord's account), Telegram bot | Code, film, alerts | Throughout |

---

## 6. (e) Repo hygiene for "meaningful human contribution"

**Layout** (monorepo; `plugin/` stays an isolated pnpm project with the starter's own lockfile and `pnpm-workspace.yaml`, outside the root workspace):

```
plugin/      starter v1.0.2 verbatim + src/{plugin.ts, paybox.ts, tools/*, core/*}, test/, tool-catalog.json, paybox-plugin.json
contracts/   src/{KeyframeEscrowFactory.sol, EscrowVault.sol}, test/{unit,fuzz,invariant,fork,sym}/, script/Deploy.s.sol, vectors/
api/         Hono/Workers: x402/, quotes/, orders/, relayer/ (DO), sanctions/, policy/, migrations/, test/{unit,interop}
render/      templates/ (human-designed HyperFrames), worker/ (poll jobs, render, encrypt, upload, settle)
keepers/     cf-keeper/ (chain-only Cron Worker), keeperhub/ (exported workflow JSON + README)
packages/x402-escrow/   MIT: Solidity + TS DynamicPayTo/facilitator middleware (post-lock)
tools/       audit-order.ts (chain-only auditor), sweep-spike.ts, gen-vectors
docs/        adr/, design/, security/{threat-model.md, invariants.md}, runbooks/, evidence/EVIDENCE.md, FRICTION.md, RELEASES.md, HUMAN_CONTRIBUTION.md
releases/    plugin-final.mjs (+ sha256)
film/        storyboard, HyperFrames film project
.github/workflows/ ci.yml (plugin pnpm test+unit, forge test, api tests), nightly.yml (halmos, deep invariants), synthetic.yml
```

**Commit discipline**
- Small conventional commits authored by the builder, as in Ripcord ("repo always green").
- Commit design iterations of the templates (style frames, `design.md` type scale, colour system, easing curves, timing sheets). These are the most visible human craft.
- Tag every portal upload (`upload-YYYYMMDD-HHMM`) and record git SHA, artefact sha256, tool-catalog hash, check result and submission status in `docs/RELEASES.md`.

**ADRs** (MADR format, in the builder's voice):

| ADR | Decision |
|---|---|
| 001 | Counterfactual CREATE2 escrow as x402 payTo |
| 002 | URL-keyed orders; body ignored |
| 003 | One x402 version per response |
| 004 | Contract-as-facilitator settlement |
| 005 | Persistent vault, no SELFDESTRUCT |
| 006 | Split-key private delivery |
| 007 | Sanctions screening off-chain (USDC blacklist already freezes at the token level) rather than an in-contract oracle |
| 008 | Two chain-only keepers |
| 009 | Plugin does the proof (independent RPC, pinned allowlists, no getLogs) |
| 010 | Freeze surfaces and the env switches |
| 011 | 7702 policy and direct rail |
| 012 | Settle latency mode (from S8) |
| 013 | $50 cap, unaudited disclosure |
| 014 | Hosting |
| 015 | Render-before-pay (ZKCP-lite) for Instant |

**Security docs**
- `docs/security/threat-model.md`, one page. Covers:
  - assets: buyer USDC at E, K_chain / K_buyer, relayer key, payout key, bundle integrity;
  - actors, including a compromised API, a compromised portal account (env allowlists are owner-controlled config, the same trust as the studio), the RPC provider and the USDC issuer;
  - attacks and mitigations: payTo substitution, seller substitution, front-running the authorization or K, register spam (bounded sweep), USDC blacklist or pause, the quality gap (disclosed).
- `invariants.md` maps each of I1–I10 to its tests.

**Human contribution and licensing**
- `HUMAN_CONTRIBUTION.md` plus a README section saying:
  - what the builder personally designed and decided: product, mechanism choices (ADRs), contract invariants, templates and motion system, film and voice;
  - where AI assisted: scaffolding and tests;
  - with links to commits.
- Licences: MIT for `contracts/` and `packages/`; templates and motion assets all-rights-reserved.

**Evidence and friction logs:** `FRICTION.md` (dated platform friction, useful feedback for MoonPay) and `EVIDENCE.md` (request_ids, tx hashes, screenshots), as in Ripcord.

---

## 7. (f) Verification: proving end-to-end correctness on mainnet

### 7.1 Local gates

```bash
# Plugin (Node 24.21.0, pnpm 11.11.0)
cd plugin && pnpm install --frozen-lockfile
pnpm --silent test | jq -e '.status=="passed"' && pnpm --silent test | jq '{artifact, discoveredToolCount}'
pnpm unit                                  # vitest: P3–P12
node scripts/catalog-snapshot.mjs && git diff --exit-code tool-catalog.json
shasum -a 256 dist/plugin.mjs              # must equal RELEASES.md row for the uploaded version

# Contracts
cd contracts
forge build --sizes && forge test -vvv
FOUNDRY_PROFILE=deep forge test --match-contract Invariant      # [profile.deep.invariant] runs=5000, depth=128
forge coverage --report summary && forge snapshot --check
forge test --match-path 'test/fork/*' --fork-url "$BASE_RPC_URL" --fork-block-number "$FORK_BLOCK" -vvv
halmos --contract KeyframeEscrowSymTest --solver-timeout-assertion 0 --loop 3

# API interop (anvil fork + wrangler dev + @x402/fetch client)
pnpm -C api test && pnpm -C api test:interop
```

### 7.2 Deploy and verify (Foundry keystore; never a raw key in `.env`)

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_RPC_URL" --account deployer \
  --broadcast --verify --etherscan-api-key "$ETHERSCAN_API_KEY" --chain 8453 -vvvv
cast code "$FACTORY" --rpc-url "$BASE_RPC_URL" | head -c 12            # non-empty
cast call "$FACTORY" "computeAddress((address,address,uint256,uint64,uint64,bytes32,bytes32,bytes32,bytes32))(address)" "$T_TUPLE" --rpc-url "$BASE_RPC_URL"
# must equal plugin keyframe_terms output for the same T (vectors + Test console)
```

Etherscan v2 behaviour with Foundry is unverified; confirm on the first deploy.

### 7.3 The 402: determinism and payee proof

```bash
Q=$(curl -s -X POST "$API/v1/quotes" -H 'content-type: application/json' \
  -d '{"buyer":"'$A'","format":"sting","params":{"title":"Ripcord"},"attest":{"brand_rights":true}}' | jq -r .quote_id)
for m in POST POST GET; do curl -s -D - -o /dev/null -X $m "$API/v1/orders/$Q" \
  | awk 'tolower($1)=="payment-required:"{print $2}' | tr -d '\r' | shasum -a 256; done   # 3 identical lines
curl -s -D - -o /dev/null -X POST "$API/v1/orders/$Q" | awk 'tolower($1)=="payment-required:"{print $2}' \
  | tr -d '\r' | base64 -d | jq '{v:.x402Version, a:.accepts[0]|{scheme,network,amount,asset,payTo,maxTimeoutSeconds}}'
cast code <payTo> --rpc-url "$BASE_RPC_URL"                            # 0x  (codeless)
```

`payTo` must equal the E that the plugin prints in `keyframe_quote`, and the E from `cast call computeAddress`.

### 7.4 Hosted proof

Portal checks green. Test console runs all 10 tools. Validate passes for `keyframe_commission` (x402 preview: amount and payee E), `keyframe_commission_direct` and `keyframe_refund` (S11).

### 7.5 Live acceptance runs from Claude.ai

Each run stores request_id(s), E, termsHash and tx hashes in `EVIDENCE.md`, and must pass the chain-only auditor:

```bash
pnpm -C tools audit-order -- --terms-hash 0x…   # or --tx 0x…
```

The auditor uses no API:
1. Rebuilds T from `order()` plus calldata.
2. Re-derives E.
3. Checks the USDC Transfer buyer→E.
4. Checks `keccak(K)==keyHash`, the payout split and `maxPayout(settledAt)`.
5. Fetches the ciphertext by hash from IPFS or R2, decrypts it, and checks the plaintext sha256.
6. Runs `ffprobe` for duration and resolution against the deal.
7. Exits 0.

Acceptance runs:

| Run | Scenario |
|---|---|
| AR-1 | Instant happy path (E1) |
| AR-2 | Cloudflare-keeper refund (F-R1) |
| AR-3 | KeeperHub refund (F-R2) |
| AR-4 | Buyer self-refund (E7) |
| AR-5 | Void (E6) |
| AR-6 | Overpay and late-funds sweep (E10) |
| AR-7 | Direct rail (E3) |
| AR-8 | Sanctions refusal: auditor confirms **no** transaction |
| AR-9 | Duplicate refusal |
| AR-10 | Studio tier (E2) |

On Basescan the expected sequence is:
1. E shows "Contract: none" while holding the USDC.
2. The `fundWithAuthorization` tx from the relayer.
3. The settle tx with K visible in the decoded input.
4. E now has vault code, and its balance is 0.

### 7.6 Release gate (G4 checklist)

All of the following must hold:
- P1–P13 green;
- C1–C3, F1–F10 green (Halmos may follow post-lock);
- A1–A9 green;
- S0–S11 resolved;
- AR-1, AR-4 and AR-5 passed on mainnet;
- E13 ≥ 9/10;
- `RELEASES.md` sha256 equals the uploaded artefact;
- the final version is **submitted**, not just uploaded.

---

## 8. Unverified register (and what retires each item)

| # | Assumption | Retired by |
|---|---|---|
| U1 | Plugin x402 accepts a per-order codeless payTo | S2 (parse), S4 (live) |
| U2 | Plugin x402 path parses the v2 header | S2, S5 |
| U3 | Probe sends no body (irrelevant with URL keying; measured anyway) | S2 log |
| U4 | Paid re-fetch timeout | S8 |
| U5 | Plugin proposal amount limit and grant policy limits | S9 |
| U6 | Auto-undelegate on Base; gas for delegated evm proposals | S10 |
| U7 | `get_request` returns the full service body; no redaction | S4, S7 |
| U8 | Upload/submission attempt limits | S0 |
| U9 | Sandbox: WebCrypto, env vars, fetch size and latency, redirects | S1 (`diag_*`) |
| U10 | Whether the X video must be posted before the deadline | Ask organisers at S0; proof cut ready |
| U11 | Whether PayBox treats `PAYMENT-RESPONSE` success as final or waits for chain confirmation | S4/S8 observation (drives ADR-012) |
| U12 | FiatTokenV2_2 bytes-signature EIP-3009 overload on Base; 7702 payers routed to the ERC-1271 path | F1, F5 |
| U13 | Deterministic deployer present on Base; Etherscan v2 verify flags | F10, §7.2 |
| U14 | Cloudflare Free per-request CPU sufficient | A9 under `wrangler dev`, then production metrics; upgrade if exceeded |
| U15 | PayAI keyless settlement to per-order payees | A10 |
| U16 | KYC turnaround | S0 |

---

## 9. Design deltas this plan recommends (for the lead to accept or reject at G2)

1. **Contract-as-facilitator.** `fundWithAuthorization(T, validAfter, validBefore, nonce, sig)` calls USDC's EIP-3009 transfer to E and registers T in the same transaction. Payment and terms become atomic on-chain, keepers and refunds become chain-only, and front-running is harmless (F4).
2. **Render-before-pay for Instant (ZKCP-lite).**
   - Draft quote → watermarked preview, then final quote with `contentHash = keccak(ciphertextSha256, plaintextSha256)` in T.
   - The payment address then commits to the exact encrypted file. The plugin checks ciphertext availability before proposing, and K is revealed seconds after funding.
   - Studio keeps bind-at-settle (`contentHash = 0`), with the residual availability risk disclosed.
   - This needs only the optional `from_quote_id` in the frozen schema.
3. **Void as `settle(payout = 0)`, with the payout choice restricted to T.seller.** Third parties holding K settle only at `maxPayout(now)` (invariant I10). This removes a separate void path and blocks front-run payout griefing.
4. **Verification via storage views, not logs.** `order(termsHash)` exposes state, K and the hashes.
5. **Env switches as post-lock control surfaces:** primary rail, 7702 policy, maintenance kill switch, factory and seller allowlists with `refund-only` status.
6. **Open-402 traction tier ≤ $1**, because default x402 clients cap at $1. Larger tiers document the cap override.
7. **Never route monitoring through the plugin** (1,000-starts/day quota). Synthetic orders use the open 402.

### Critical Files for Implementation
- /Users/oluwademilade/Desktop/paybox/plugin/src/plugin.ts
- /Users/oluwademilade/Desktop/paybox/plugin/src/core/terms.ts
- /Users/oluwademilade/Desktop/paybox/contracts/src/KeyframeEscrowFactory.sol
- /Users/oluwademilade/Desktop/paybox/api/src/x402/orders.ts
- /Users/oluwademilade/Desktop/paybox/docs/design/frozen-interfaces.md
