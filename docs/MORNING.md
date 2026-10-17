# Good morning — Keyframe status & your runbook

**Upload lock:** Sat Oct 17, 8:00 pm EDT (1:00 am Sunday your time). After it, `plugin.mjs` can't change; hosts, env vars,
secrets and the whole backend still can.

## Where things stand (all verified; nothing has touched mainnet or spent money)

| Area | State |
|---|---|
| Escrow contracts (`contracts/`) | **186 tests** incl. 24 Base-fork tests (real USDC) + 19 audit regressions, 15/15 invariants, 100% branch coverage, Halmos 10/11. Independent audit: **no critical/high**; its findings are fixed (rotating keeper cursor, best-effort buyer push, 14-day review cap, 50% kill-fee cap). |
| Plugin (`plugin/`) | 9 tools, starter conformance **passed**, **258** unit tests incl. anvil tests against the real factory. Adversarial review's 2 highs + 3 mediums + 4 lows fixed (payment tools now bound to `buyer` + `terms_hash`). Upload artifact: `plugin/dist/plugin.mjs`, sha256 `de79e90e…` (re-check with `scripts/deploy-mainnet.sh portal`). |
| x402 API (`apps/api/`) | Workers + D1 + KV + R2 + relayer DO + keeper cron. **122** tests. Security review's 2 highs + 6 mediums + 7 lows fixed. Being patched now: Alchemy's free tier allows `eth_getLogs` over only 10 blocks, which broke direct-rail registration → dedicated logs RPC + chunked fallback. |
| Render worker (`apps/worker/`) | HyperFrames → faststart MP4 → KFC1 encrypt. 63 tests; renders byte-identical; countdown ≈ 10 s on your Mac. |
| End-to-end | Base mainnet fork, real USDC: **47/48** after all security fixes (only the direct-rail step, fix in progress); earlier run 49/49. Covers quote → render → x402 pay → sealed → key published → plugin decrypts & verifies; keeper + buyer refunds; Studio review; private delivery; concurrent payments charged once. Re-run: `scripts/e2e-fork.sh`. Evidence: `docs/evidence/INTEGRATION.md`. |
| Relayer / operator key | Created in `.env` → `0xc1AF1dd7c4816a40aB69578E52CCbB4ddBFFda04` (unfunded; `scripts/deploy-mainnet.sh relayer --fund 0.0015` tops it up from the deployer). |
| Spike server | Live at `https://keyframe-spike.keyframe-spike-server.workers.dev` (deterministic v2 402, codeless payee verified on Base). |
| Cloudflare | D1 `keyframe`, KV `KEYFRAME_KV`, R2 `keyframe-files` created (`docs/deploy/cloudflare-resources.md`). |

## What only you can do — in order

0. **Plug the Mac in** (it was on battery at 08:34) and keep VS Code / this session open.
1. **Studio payout wallet (B)** — 2 min. In the PayBox app create (or pick) an EVM wallet for studio revenue and add its
   address to `~/Desktop/paybox/.env` as `SELLER_ADDRESS=0x…`. Don't grant it to any agent. It is baked into the factory
   forever (immutable), so pick one you'll keep. Then tell me "go" and I run, in order:
   `scripts/deploy-mainnet.sh plan` → `factory --broadcast` → `relayer --fund 0.0015` → `api` → `portal`, and start the
   render worker on your Mac (≈20 min).
2. **Buyer wallet (A)** — 5 min. An EVM PayBox wallet that is a *plain* account (avoid gasless swaps on it first), with
   ~**$15 USDC on Base** (+ ~$1 ETH on Base if you want to demo the direct rail). Connect the **PayBox connector in
   claude.ai** (Settings → Connectors → PayBox → Connect) and grant **only wallet A**.
3. **Move the spike mnemonic** I generated (`SPIKE_MNEMONIC` in `.env`, used only for test payees) into your password
   manager, then delete it from `.env`.
4. **Portal** (I'll prepare the exact file + values): upload `plugin/dist/plugin.mjs`, add network hosts + env vars, run
   hosted checks, Test console, **Validate transaction** (no money). Then **accept the T&C and click Submit Project**
   (only you can), enable the plugin under PayBox → Plugins → Unofficial.
5. **Live order from Claude.ai** — one Countdown ($1): one passkey tap → sealed → key published → verified. This is the
   real interop proof (per-order escrow payee through PayBox's x402).
6. **Your craft (the "meaningful human contribution" rule):** design the hero template(s) — `templates/launch_sting/`
   (and `portfolio_pulse/`). The system, variables schema and a plain reference template (`templates/countdown/`) are
   ready; `templates/_kit/MOTION.md` is yours to fill. Backend-only change — fine after the lock.
7. **Film** (75–90 s, your voice) — shot list in `docs/design/product-render-demo.md` §C. Posted to X.

## Decisions waiting for your sign-off (ADRs marked "proposed" in `docs/adr/`)
- ADR-017: the render worker receives a per-file key `K_file` (never KMASTER/K_chain/K_buyer).
- ADR-019 / Studio "changes": after a change request nothing releases on silence; buyer accepts the revision or is refunded.
- Caps: 0.10–50 USDC per order, Studio review ≤ 14 days, kill fee ≤ 50%. Contracts are unaudited (disclosed).
- Etherscan's free API no longer covers Base → contracts get verified on **Sourcify + Blockscout** instead.

## Known gaps
- Only **Countdown** and **Studio** are sellable until your templates exist (the API refuses the others with a clear 422).
- `chart_moment` needs a market-data provider (post-lock).
- The X demo video timing rule is unconfirmed — if it must be posted before the lock, record a 60 s proof cut after step 5.
