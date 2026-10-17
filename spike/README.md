# Keyframe DAY-1 interop spike kit

This kit answers the questions in `docs/design/verification.md` S0 to S11 before any escrow contract exists. Each order's payee is a **codeless, recoverable HD address** `P_i`: index `i` of a mnemonic that only you and the Worker hold. To PayBox it looks exactly like a counterfactual CREATE2 escrow. All USDC sent during the spikes can be swept back afterwards without the payee paying gas (`tools/sweep-spike.ts`).

```
spike/
  server/   Hono on Cloudflare Workers: quotes, the x402 order resource, diagnostics, request log
  plugin/   PayBox plugin "keyframe-spike" (starter v1.0.2 tooling byte-identical): 5 tools
  tools/    sweep-spike.ts (EIP-3009 sweep), mcp-call.mjs (local MCP harness), fetch-map-preload.mjs (test only)
```

## Pinned versions

| What | Version |
|---|---|
| Node / pnpm | 24.21.0 (`.tools/node-v24.21.0-darwin-arm64/bin`) / 11.11.0 (from `packageManager`) |
| Server | hono 4.13.13, @x402/core 2.28.0, @x402/evm 2.28.0, viem 2.51.3, zod 4.4.3, wrangler 4.147.0, @cloudflare/workers-types 5.20261004.1, typescript 5.9.3, tsx 4.23.12 |
| Plugin | starter v1.0.2 pins (@modelcontextprotocol/server 2.0.0, zod 4.4.3, esbuild 0.28.2, typescript 5.9.3, tsx 4.23.12, ajv 8.20.0, @types/node 24.12.2) + viem 2.51.3 |
| Tools | viem 2.51.3, tsx 4.23.12, typescript 5.9.3 |

Run every command below with the pinned Node first on PATH:

```bash
export PATH="$PWD/.tools/node-v24.21.0-darwin-arm64/bin:$PATH"   # from the repo root
```

## Ground rules

- **Never paste a mnemonic or private key into chat, a file, a commit or a command line.** Type secrets only at a hidden prompt (`wrangler secret put`, or `read -rs`).
- The spike payees are test addresses. Sweep them back when you finish (section 9).
- Money is only ever moved by you, approving in PayBox from Claude.ai. The Test console and **Validate transaction** never sign or pay anything.
- Every request to `/v1/orders/*` is logged without secrets. Read the log with `GET /v1/diag/log?quote_id=…` (section 10).

---

## 1. Deploy the spike server (Cloudflare Workers)

1. **Create the Cloudflare account** at dash.cloudflare.com and enable Workers.
   - Workers Paid ($5) is recommended. On the Free plan, quote creation (BIP-32 derivation) can exceed the 10 ms CPU limit and fail with error 1102; if that happens, just retry.
   - The Free plan's KV limit is 1,000 writes a day. The spike uses about 2 to 4 writes per request, which is plenty.
2. **Install and log in:**
   ```bash
   cd spike/server
   pnpm install --frozen-lockfile
   pnpm dlx wrangler@4.147.0 login        # or: pnpm exec wrangler login (same pinned 4.147.0)
   ```
3. **Create the KV namespace:**
   ```bash
   pnpm exec wrangler kv namespace create SPIKE_KV
   ```
   Paste the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`, replacing `00000000000000000000000000000000`.
4. **First deploy:**
   ```bash
   pnpm exec wrangler deploy
   ```
   Wrangler prints the URL, `https://keyframe-spike.<your-subdomain>.workers.dev`.
5. **Set `PUBLIC_BASE_URL`.**
   - In `wrangler.toml` `[vars]`, set `PUBLIC_BASE_URL = "https://keyframe-spike.<your-subdomain>.workers.dev"` (https, no trailing slash). Every 402 names this canonical origin.
   - Redeploy with `pnpm exec wrangler deploy`.
6. **Create a fresh mnemonic locally, then store it as a Worker secret:**
   ```bash
   cast wallet new-mnemonic --words 24
   ```
   - Copy the phrase into your password manager. You need it later to sweep.
   - Note the printed account 0 `Address`. It must equal the `pay_to` of the first quote (index 0).
   - Then:
     ```bash
     pnpm exec wrangler secret put SPIKE_MNEMONIC      # paste the phrase at the hidden prompt
     clear && printf '\e[3J'                           # wipe the terminal scrollback
     ```
   - Never put the phrase in `.dev.vars`, `.env`, chat, or a shell argument.
7. **(Recommended) Protect quote creation with an admin token,** so strangers cannot burn HD indexes or KV writes:
   ```bash
   export SPIKE_ADMIN_TOKEN="$(openssl rand -hex 24)"
   printf %s "$SPIKE_ADMIN_TOKEN" | pnpm exec wrangler secret put SPIKE_ADMIN_TOKEN
   ```
   Keep that shell open. The curl commands below send `-H "authorization: Bearer $SPIKE_ADMIN_TOKEN"`; drop that header if you skip this step.
8. **Smoke test.** Use a shell with `jq` and `cast`.
   ```bash
   API=https://keyframe-spike.<your-subdomain>.workers.dev
   A=0xYourWalletA                       # PayBox wallet A (buyer), EIP-55 checksummed
   curl -s $API/health | jq              # mnemonic_configured: true, x402_mode: v2, public_base_url = $API
   Q=$(curl -s -X POST $API/v1/spike/quotes -H 'content-type: application/json' \
         -H "authorization: Bearer $SPIKE_ADMIN_TOKEN" -d "{\"buyer\":\"$A\",\"amount\":\"100000\"}" | tee /dev/stderr | jq -r .quote_id)
   for m in POST POST GET; do curl -s -D - -o /dev/null -X $m $API/v1/orders/$Q \
     | awk 'tolower($1)=="payment-required:"{print $2}' | tr -d '\r' | shasum -a 256; done   # 3 identical lines
   curl -s -D - -o /dev/null -X POST $API/v1/orders/$Q | awk 'tolower($1)=="payment-required:"{print $2}' \
     | tr -d '\r' | base64 -d | jq '{v:.x402Version, url:.resource.url, a:.accepts[0]}'
   cast code $(curl -s $API/v1/quotes/$Q | jq -r .pay_to) --rpc-url https://mainnet.base.org   # 0x
   curl -s "$API/v1/diag/log?quote_id=$Q" | jq '{count, deterministic_402, distinct_unpaid_402_payment_required_sha256}'
   ```
   **Pass:**
   - three identical hashes;
   - `x402Version` 2;
   - `resource.url` = `$API/v1/orders/$Q`;
   - one accepts entry with `scheme exact`, `network eip155:8453`, `amount 100000`, `asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `payTo` = quote `pay_to`, `maxTimeoutSeconds 300`, `extra {name:"USD Coin", version:"2"}`;
   - `cast code` prints `0x`;
   - `deterministic_402: true`.

**Changing a knob** (`X402_MODE`, `PAID_DELAY_MS`, `SETTLE_MODE`, `PAID_BODY_PAD_BYTES`, `MAX_AMOUNT_ATOMIC`): edit `[vars]` in `wrangler.toml`, then run `pnpm exec wrangler deploy` (a few seconds). The plugin never needs re-uploading for a knob change. Check `/health` after each change. Use a **new quote** after changing `X402_MODE`.

## 2. Build the spike plugin

```bash
cd spike/plugin
pnpm install --frozen-lockfile
pnpm --silent test | jq '{status, sampleCall, artifact, discoveredToolCount}'   # status "passed", 5 tools
shasum -a 256 dist/plugin.mjs                                                  # record it next to the upload
```

The sample call (`paybox-plugin.json`) is `diag_env`, which runs offline. The plugin's embedded API default is `https://keyframe-spike.example.workers.dev`. The real origin comes from the portal variable `KEYFRAME_API_BASE`, so the bundle never changes per deployment.

| Tool | Kind | Purpose |
|---|---|---|
| `diag_env` | data, offline | Node and platform; `typeof crypto.subtle`; `typeof AbortSignal.timeout`; **names** of `KEYFRAME_*` variables |
| `diag_fetch` | data | `eth_chainId` on mainnet.base.org and on Alchemy (brokered header), plus timed 1 / 5 / 10 MB blobs from the API. 4 s per request, under 9 s in total |
| `diag_paid_echo` | data, offline | Canonical sha256, keys, strings over 64 characters, and the checksum of a Keyframe paid body |
| `keyframe_commission` | **x402** | GETs the quote, pre-fetches the 402 (POST, no body), checks the single exact USDC / Base challenge (payee and amount equal the quote), returns `proposeX402(POST /v1/orders/{q})` |
| `keyframe_commission_direct` | **evm** | `USDC.transfer(pay_to, amount)` on eip155:8453 |

## 3. Upload and configure in the developer portal (S1)

1. Go to developer.paybox.sh and use **Register with PayBox**.
   - Note the eligibility/KYC badge, the upload and submission attempt counter, and whether the name and blurb stay editable after upload.
   - This project is your **single hackathon entry**. If the name and blurb cannot be edited later, use the final copy from `docs/PLAN.md`.
   - Upload `dist/plugin.mjs` with:
     - Project name (≤ 80 characters): `<PROJECT NAME>`, e.g. `Keyframe: hire a motion designer from chat, pay only on delivery`
     - What does your project do? (≤ 280 characters): `<DESCRIPTION>`, the 276-character blurb in `docs/PLAN.md`
2. In **Test & configure → Network hosts**, add exactly these three:
   - `keyframe-spike.<your-subdomain>.workers.dev`
   - `mainnet.base.org`
   - `base-mainnet.g.alchemy.com`
3. In **Variables & Secrets**:
   - Environment variable `KEYFRAME_API_BASE` = `https://keyframe-spike.<your-subdomain>.workers.dev`. It must equal `PUBLIC_BASE_URL`.
   - Secret: host `base-mainnet.g.alchemy.com`, header `Authorization`, value `Bearer <ALCHEMY_KEY>` (from your Alchemy Base app).
4. **Run checks.** If one failed because settings were missing, wait 30 s, then **Run checks again**.
   - **Pass:** green, 5 tools discovered.
5. **Test console → Load tools**, then run each tool:

| Tool | Input | Pass criteria |
|---|---|---|
| `diag_env` | `{}` | `node` v24.x; `crypto_subtle` "object"; `abort_signal_timeout` "function"; `keyframe_env_names` contains `KEYFRAME_API_BASE`; `api_base_source` "env" |
| `diag_fetch` | `{}` | `rpc_base_public` 200 with `chain_id_ok`; `rpc_alchemy_brokered` **200** with `chain_id_ok` (proves the brokered header; a 401 means the secret is missing or wrong); `blob_5mb` ok in < 3000 ms; `total_ms` < 9000. Re-run with `{"sizes_mb":[10]}` if the 10 MB fetch was skipped for budget |
| `diag_paid_echo` | `{"paid_response":{"hello":"world"}}` | Returns a sha256; `paid_body` null |
| `keyframe_commission` | `{"quote_id":"<Q>"}` (fresh quote, buyer A) | A proposal with `kind x402`, url `$API/v1/orders/<Q>`, method POST, `maxAmount` 100000, `expiresAt` ≤ 300 s ahead. The text names the payee |
| `keyframe_commission_direct` | `{"quote_id":"<Q>"}` | A proposal with `kind evm`, `to` USDC, `value 0`, data = `cast calldata 'transfer(address,uint256)' <pay_to> 100000` |

Record any failure under the S1 fail/fallback table in `verification.md`. In particular: no WebCrypto, env vars not visible, large fetches slow, or redirects broken.

## 4. S2: Validate the unpaid x402 proposal (no money)

1. Create a quote with `buyer` = wallet A and `amount` = `100000` (section 1.8).
2. Test console: run `keyframe_commission {"quote_id":"<Q>"}`.
3. Within **5 minutes**, select **Validate transaction** with wallet A.
4. Run the 3-fetch hash loop from 1.8 again.
5. Read the log: `curl -s "$API/v1/diag/log?quote_id=$Q" | jq`.

**Record:**
- the preview (screenshot): amount, payee, any warning text;
- every PayBox request in the log: method, `ua`, `accept`, `content_length`, `body_bytes` (expected 0: no body), and how many requests it sent;
- `deterministic_402` and the distinct hash list. PayBox's probe, the plugin's pre-fetch (the plugin text prints its hash) and curl must share **one** sha256.

**Pass:** the preview shows 0.10 USDC to `P_i`, and `deterministic_402: true`.

**Fail:**
- (a) Parse error on v2: go to S5 (`X402_MODE=v1`) and Validate with a new quote.
- (b) Both versions fail: Validate the starter x402 example against a known-good Base endpoint to separate "our 402" from "PayBox".
- (c) The payee itself is rejected: Plan B, where the primary rail is `keyframe_commission_direct`.

Write ADR-002 and ADR-003.

## 5. S5: v1 wire (no money)

1. Set `X402_MODE = "v1"`, deploy, and check `/health` shows `x402_mode: v1`.
2. Create a **new** quote.
3. Confirm the 402 has **no** `PAYMENT-REQUIRED` header and a JSON body with `x402Version 1`, `network "base"`, `maxAmountRequired`:
   ```bash
   curl -s -D - -X POST $API/v1/orders/$Q
   ```
4. Run `keyframe_commission` (its text says "x402 v1"), then **Validate**.
5. Record the result, then set `X402_MODE = "v2"` back and deploy.

**Pass:** both outcomes recorded. Never mix versions in one response; the server emits exactly one.

## 6. S4: live 0.10 USDC plugin order from Claude.ai

**Before you start:**
- Accept the T&C and select **Submit Project** (agent testing requires a submitted project).
- In the PayBox app, go to Plugins → **Unofficial plugins** and enable your plugin.
- In Claude.ai, use the PayBox connector with **only wallet A** granted. A holds ≥ 0.20 USDC.

**Steps:**
1. Create a fresh quote: buyer A, `100000`.
2. In a new chat, send: *"Use my Keyframe spike plugin: run keyframe_commission for quote `<Q>` from my buyer wallet, then follow the PayBox request until it finishes and show me the service response."*
3. Expected sequence: `list_credentials` → `discover_plugins` → `use_plugin(keyframe_commission)` → pending approval → passkey → `get_request` until terminal.

**Measure:**
- the approval sheet (screenshot the payee display);
- the time from approval to success;
- the `get_request` output shape;
- the log entries: the probe; any approval-time re-fetch; the paid attempt (`payment_header_name` PAYMENT-SIGNATURE vs X-PAYMENT, `x402_version_of_payload`, `status`, `ms`, `note`).

**Pass:**
- exactly one Basescan Transfer A→`P_i` of 100000;
- the log shows the paid attempt with `status 200` and note `settled`;
- `order.settlement_tx` in `/v1/diag/log` matches Basescan;
- `get_request` is `success` with our JSON body (`order_id`, `quote_id`, `pay_to`, `amount`, `settlement_tx`, `received_at`, `checksum`);
- one approval.

**Diagnose with the log `note` values:**
- `accepted_rewritten:<keys>`: PayBox echoed `accepted` with cosmetic differences, and the server matched it anyway. Record the keys.
- `accepted_mismatch:<keys>` with 402: the signed authorization does not pay our payee and amount.
- `verify_rejected`: the facilitator's reason is in the 402's `error` field.
- `idempotent_replay`: PayBox re-sent the same payment and got the stored 200 (no second transaction).
- `already_paid_different_nonce` (409): a second authorization was refused, not charged.
- `settle_failed:<reason>`.

## 7. S7: `get_request` body integrity (0.10 USDC)

1. Set `PAID_BODY_PAD_BYTES = "3500"` and deploy. The paid body is now about 4 KB: a 64-hex `s7.k_buyer_test`, nested objects, unicode, padding, and `checksum` = sha256(canonical JSON of the rest).
2. Run the S4 flow on a new quote.
3. Ask the agent: *"Pass the complete get_request output for that payment into diag_paid_echo as paid_response."*

**Pass:**
- `paid_body.checksum_matches: true`;
- `k_buyer_test_length` 64;
- `string_fields_over_64` lists `s7.pad` with length 3500. Nothing is truncated or redacted.

**Fail:** paid bodies carry IDs only, and `k_buyer` moves to the SIWE path (freeze item). Afterwards set `PAID_BODY_PAD_BYTES = "0"`.

## 8. S8: paid re-fetch latency tolerance (4 × 0.10 USDC)

Run S4 with `SETTLE_MODE = "wait"` and `PAID_DELAY_MS` stepping through 0 → 4000 → 9000 → 20000, on a **new quote each time**. Stop at the first failure.

**How the delay works:** it sleeps before verify. If the client has disconnected by then, the server does not verify or settle. The log shows `client_aborted_before_verify;not_settled` with status 499. If the runtime cancels the invocation instead, the log shows only the `in_flight` entry and no final one.

**Record for each step:**
- PayBox's terminal status and text;
- whether USDC moved (`pnpm -C spike/tools sweep --indexes <i> --to $A` in dry-run shows the balance);
- the log notes;
- whether PayBox retried (several paid entries for the same quote).

| Measured tolerance | ADR-012 decision |
|---|---|
| ≥ 10 s | Wait for the receipt; truthful PAYMENT-RESPONSE |
| 4–10 s | Pre-simulate, broadcast, then return 200 with the tx hash immediately; confirm in the background |
| < 4 s | As above, plus warm RPC and a Durable Object relayer |

**Optional:** at the failing step, retry with `SETTLE_MODE = "broadcast"`. The server answers 200 right after verify, the body says `settlement: "deferred"`, and settlement finishes in the background (`order.deferred_settlement` in the log). PayAI exposes no broadcast-only call, so this is the closest equivalent.

**Unverified locally:** under `wrangler dev`, `request.signal` never fires on client disconnect. The deployed Worker has the `enable_request_signal` flag, so S8 is where this is first observed. If the log ever shows `settled` after PayBox reported a timeout, funds moved without a visible response. That is exactly the "paid but no response" case: record it and sweep.

Reset to `PAID_DELAY_MS = "0"` afterwards.

## 9. S9: 8 and 50 USDC, then sweep (58 USDC, recoverable)

1. Top A up to ≥ 60 USDC. `MAX_AMOUNT_ATOMIC` must be `50000000` (the default).
2. Create quotes for `8000000` and `50000000`. Run S4 for each and approve.
3. **Pass:** both reach approval and settle. **Fail:** record the denial reason.
   - Grant policy: use `request_account_change`.
   - A plugin amount limit L: set the cap to L and plan milestone or direct orders.
4. **Sweep everything back to A.** Read the secrets at hidden prompts; they are never echoed or stored.
   ```bash
   cd spike/tools && pnpm install --frozen-lockfile
   read -rs SPIKE_MNEMONIC && export SPIKE_MNEMONIC          # paste the phrase, press Enter
   pnpm sweep --indexes 0-12 --to $A                        # DRY RUN: address, code state, USDC per index
   pnpm sweep --indexes 0-12 --to $A --sign                 # signs, eth_call-simulates against USDC, prints authorizations + cast send lines
   read -rs RELAYER_PRIVATE_KEY && export RELAYER_PRIVATE_KEY  # any key with a little Base ETH
   pnpm sweep --indexes 0-12 --to $A --submit               # relays transferWithAuthorization, waits for receipts
   unset SPIKE_MNEMONIC RELAYER_PRIVATE_KEY
   ```
   The payee pays no gas. The relayer pays about 60k gas per index. Authorizations are valid for `--valid-seconds` (default 3600) and can only pay `--to`.

## 10. S10: EIP-7702-delegated wallet C (~$1–2)

1. Grant wallet C to the connector. Check `cast code <C> --rpc-url https://mainnet.base.org` = `0x`.
2. Have the agent do a tiny gasless PayBox operation with C, for example `request_swap` of 1 USDC → ETH on Base. Then `cast code <C>`; expect `0xef0100…` (23 bytes).
3. Create a quote with buyer C and run `keyframe_commission`. Observe either:
   - (a) a plain-EOA error, or
   - (b) the undelegate-then-sign window, after which `cast code C` is `0x` again.
4. With C delegated, run `keyframe_commission_direct` and note whether gas is sponsored or needs ETH.
5. Set `KEYFRAME_7702_POLICY` (`x402-autoundelegate` or `direct-first`) in the plan and write ADR-011.

**Pass:** behaviour documented. **Fail:** if you cannot produce a delegated wallet, mark it unverified and rely on fork tests.

## 11. Reading the request log

```bash
curl -s "$API/v1/diag/log?quote_id=$Q" | jq
```

**Response fields:**
- `count`
- `unpaid_402_count`
- `distinct_unpaid_402_payment_required_sha256`
- `deterministic_402` (S6: must stay `true`)
- `order`: `order_id`, `from`, `nonce`, `settlement_tx`, `wire`, `paid_at`, `deferred_settlement`
- `entries[]` in time order, each with:
  - `ts`, `method`, `path`, `ua`, `accept`, `content_length`, `body_bytes`
  - `payment_header_name`: PAYMENT-SIGNATURE / X-PAYMENT / null
  - `x402_version_of_payload`
  - `payment_required_sha256`: the header (v2) or the body (v1) of the 402 we emitted
  - `payment_required_source`, `status`, `ms`, `wire`, `note`

**What the log never holds:** IPs, payment signatures, or secrets.

**Timing:** KV is eventually consistent, so allow up to about 60 s for entries written from another PoP. Requests whose path has no valid quote id are logged under `quote_id=_other`.

## 12. Local verification (no money, no Cloudflare account)

```bash
bash spike/server/scripts/local-verify.sh      # needs jq; cast optional
pnpm -C spike/server selftest                  # derivation parity vs viem mnemonicToAccount, id format, v1 stability
```

The script creates a TEST mnemonic in memory and passes it to `wrangler dev` through the environment only. It runs:
- five local Workers: v2; v1; v2 and v1 against a local **mock** facilitator; and delay + deferred settle against a second mock;
- the 402 determinism checks, decode and `cast code`;
- a real-signature payment from an unfunded key against PayAI (expected: `invalid_exact_evm_insufficient_balance`, nothing settles);
- the mock paid path: 200, byte-identical replay, 409 for a second nonce, 409 for unpaid-after-paid, tolerant `accepted` rewrite, S7 body through `diag_paid_echo`;
- the plugin's tools through `tools/mcp-call.mjs`. A test-only preload maps `https://keyframe-spike.local` to the local port, because the unmodified bundle only accepts https:443 origins, as PayBox requires.

Finally, it checks that the mnemonic never appears in logs or files.

## 13. Out of scope here

- **S3** (optional `use_service` rehearsal): point core `use_service` at `$API/v1/orders/<Q>` with method POST; the same log applies.
- **S11** (refund / direct Validate) needs the deployed factory and belongs to the main build.
- Monitoring must not go through the plugin, because of the 1,000 starts a day quota.
