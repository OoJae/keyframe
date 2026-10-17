# PayBox Hackathon (MoonPay Hackathons Ch.1) — Research, 5 Ideas, Champion & Build Plan

## Context
Goal: win 1st place in MoonPay Hackathons Chapter 1 ("build a plugin for the PayBox marketplace").
User asked for: research → 5 candidate projects → pick the champion after weighing every variable,
ignoring the deadline (no under-scoping). Workspace `/Users/oluwademilade/Desktop/paybox` is empty (greenfield).

## Verified platform facts (read first-hand from docs.paybox.sh/llms-full.txt, developer.paybox.sh/requirements.md, starter v1.0.2)

**PayBox** = MoonPay's non-custodial wallet for AI agents. Credentials: Card (Basis Theory → agent gets a one-time,
merchant-bound virtual card), Wallet (MoonX MPC, EVM + Solana → agent gets signatures/txs), Secret (KMS → short-lived token).
Agents connect via MCP `https://api.paybox.sh/mcp` (OAuth 2.1+PKCE; Claude.ai, ChatGPT, grok.com) or `@paybox-sh/sdk` CLI.
Approval modes per grant: `always_approve` (passkey) · `iframe` (in-chat signing window) · `autonomous`.
Core tools: list_credentials, request_payment/claim_payment_credentials, request_wallet_sign (EIP-191/712/1559/7702, Solana),
request_secret, request_swap (MoonX, cross-chain), discover_tokens, get_portfolio, get_buy_link (MoonPay on-ramp),
discover_services / pay_x402 / use_service (x402), get_request, list_requests, request_account_change,
discover_plugins / get_contract / use_plugin. First-party plugins today: 6, all DeFi/trading (see live snapshot below).

**What a hackathon "plugin" is** (developer.paybox.sh/requirements.md):
- Standard TypeScript MCP server (`@modelcontextprotocol/server` 2.0.0, protocol `2026-07-28`, zod 4, Node 24.21, pnpm 11.11)
  bundled to ONE `dist/plugin.mjs` (≤10 MiB, deterministic build), uploaded in the developer portal, hosted by PayBox.
- Fresh sandbox per call → **no persistent memory/disk**; **10 s budget per call**; HTTPS only to **≤16 exact hostnames**;
  API keys = host-scoped **brokered headers** (plugin never sees them); ≤256 tools; **no custom UI**.
- Money actions = return ONE unsigned proposal in `structuredContent["io.paybox/transactionProposal"]`:
  `evm` (single call {to,value,data}, no batching) · `solana` (unsigned legacy/v0 ≤1232 B, single signer) ·
  `x402` (USDC on Base or Solana, ≤5-min expiry, HTTPS GET/POST ≤64 KiB, no custom headers).
  PayBox simulates → transaction window → **plugin money tools always need user approval** → signs → broadcasts → confirms.
- Plugin cannot pick the wallet (agent passes `wallet_id`) and cannot itself request EIP-712 signatures
  (the agent can, via core `request_wallet_sign`). Transaction window shows raw details only (no decoded token summary).
- Submit: one project per participant (individuals only), MoonPay KYC email must match PayBox email; upload → hosted checks →
  Test console → Validate transaction (simulation) → accept T&C → **Submit Project**. Appears under "Unofficial plugins".
  Uploads lock at the deadline (Sat Oct 17, 8 pm ET); config (hosts/secrets) stays editable after.
- Judging (T&C): quality, completeness, compliance, creativity, usefulness, technical execution. Required: live plugin E2E +
  demo video posted to X. Prizes $5k/$3k/$2k/10×$1k; winners enter the marketplace early + MoonPay GTM advisory.
  AI-generated work without meaningful human contribution can be disqualified.

## Builder constraints (from user)
- Skills the user personally owns: TypeScript/Node + viem/EVM (prior build: Ripcord — Aave liquidation-protection agents on Base
  via KeeperHub, with a cinematic demo film + site), Solidity, Solana/Rust, video & motion, frontend/design.
- Budget: ≤ ~$100 real money, and it should be **recoverable** → demo money should flow into our own contracts/services,
  withdrawable vaults or refundable escrow, not irreversible third-party spend (physical goods, losing bets, pricey APIs).
- Deadline explicitly ignored by the user (scope for the best possible product).
- **Solo only** — every on-camera role is played by the builder with their own (disclosed) wallets.
- **No real-world corridor access and no registered business (no KYB)** → rules out Nigeria bill-pay DvP (no meter/biller
  account), Paycrest/MoonPay-sell off-ramps, multi-rail payroll, and anything needing MoonPay partner/Commerce API keys.

## Developer portal (screenshot from user, developer.paybox.sh/dashboard)
- 3 steps: Build plugin → Upload & test → Submit Project. Upload form: **Project name ≤ 80 chars**, **"What does your project do?" ≤ 280
  chars**, built file `dist/plugin.mjs` ≤ 10 MiB ("Upload for testing"). Countdown read ~23h51m at Sat 01:08 local.
- MoonPay's own "Need an idea?" list: prediction-market price gaps · new token launch research · wallet activity insights · token
  momentum signals · tokenized asset research → expect the field to cluster heavily in DeFi data/research; differentiate away from it.

## Live marketplace snapshot (pulled 2026-10-16 via user's `paybox` CLI 2.2.0, read-only)
**Official plugins (6, `has_more:false`) — all DeFi/trading, 4 of 6 on Solana:**
| Plugin | Tools | Read / write |
|---|---|---|
| world | Kalshi-style YES/NO markets tokenized on Solana: search, events, markets, price history, orderbook, positions, buy, change position, redeem | full price→enter→settle loop |
| aave | aave_markets, aave_position | **read-only** (no supply/repay/protect) |
| kamino | list/metrics/portfolio + deposit/withdraw lending vaults | Solana savings |
| jupiter | token discovery, swap, limit/DCA orders (auth session), Earn deposit/withdraw | Solana trading + earn |
| hyperliquid | markets, prices, token | read-only |
| sunrise | list tokenized-stock assets, swap | Solana tokenized equities |

**Curated x402 services (`discover_services`, 80 endpoints / 20 hosts):** data & RPC (OneSource, Birdeye, Arkham, Blocksize FX/metals,
EDGAR, prices), utilities (api-xpay, 402rates, oblique Bazaar-pulse), LLM inference (BlockRun), scraping (Apify), X search,
AgentMail; commerce-adjacent: Bitrefill gift-card search, laso.finance $5 US prepaid card, Agentic Reservations (Resy booking $0.01),
BRIJ flights (escrow-backed booking intents on Solana).

**Gap analysis:** zero Creative coverage (no generative media even in curated x402), zero Merchant tooling (no checkout, invoicing,
merchant-side acceptance, refunds/escrow), consumer finance limited to Solana DeFi savings (nothing for P2P/remittance/off-ramp/bills/
budgets/EVM savings), Predictions already served end-to-end by first-party World → a Predictions entry must not be "trade markets".

## Research findings (8-agent sweep, ~430 sourced facts; full corpus: tasks/wthd1i451.output)
**PayBox/MoonPay context.** PayBox launched Jul 29 2026 (Claude/ChatGPT), Grok Aug 31, Muse (Meta) via CLI Sep 17. Run by
Launchpad Ltd (BVI, unregulated MoonPay entity — also the hackathon operator); MoonPay Labs builds it (Neeraj Prasad, chief
engineer; ex-Dawn). Launch chains: Solana, Ethereum, Base, Arbitrum, Polygon, Hyperliquid, Tempo, Robinhood Chain (app also lists
BNB, Optimism, Avalanche, Arc). Launch x402 partners: AgentRes (Resy), Purch (Amazon), BRIJ (flights). App bundle hints at upcoming
xp / collector-crypt / whop / maple / dflow plugins and approval types ticket_purchase, commerce_purchase, prediction_trade.
Unofficial plugins = remote (MCP URL) or sandbox (hosted bundle — hackathon entries).

**MoonPay strategic hooks.** MoonPay Commerce (ex-Helio, 6,000+ merchants) is natively agent-payable over x402
(`POST api.hel.io/v1/x402/checkout/{paylinkId}?payerAddress=…`, USDC Base/Solana) and lists "MCP server" + "ACP" on its roadmap.
Entendre acquisition = "agentic finance" (reconciliation/bookkeeping). PayBox has an on-ramp but **no off-ramp** (MoonPay sell
widget pays NGN/KES/MXN/BRL, ACH/SEPA/PayPal/Venmo; needs partner keys + HMAC-signed URLs). MoonPay co-presents the Lumara AI Film
Festival with Venice (awards Oct 26, NYC). DFlow + Dawn acquisitions (prediction markets). MoonPay is an x402 Foundation Premier member.
Oct 2026 "rogue agent" news (OpenAI wallet incident, Amazon blocking Muse, Dimon warning) → "agent acts, human approves with a passkey" lands.

**x402 reality.** Real volume ≈ $1.2M/30d (x402scan), heavily concentrated/wash-traded; Bazaar ≈ 40.8k endpoints, only ~1.3% have ≥10
payers. Agent money goes to real-world fulfilment, compute and trust — not resold free data. Unfilled gaps: refunds/escrow (auth-capture
scheme v1.1 has no facilitator support; Base `AuthCaptureEscrow` audited contracts exist), signed offers/receipts, delivery guarantees
(~11% of paid endpoints don't deliver promised fields), spend ledgers, budgets. Creative x402 supply is thin (StableStudio is the main one).

**What wins 1st (inferred model).** Gates: live E2E with real money, compliant, visibly human-made. Then ~25% usefulness/marketplace fit,
~20% PayBox-native depth, ~20% non-cliché mechanism, ~20% demo clarity & wow, ~10% robustness, ~5% traction. Among finalists,
originality + a visible real-world outcome decides 1st. Demo: 60–90 s, value in first seconds, own voice (no TTS), explorer proof.

**Kill list (judges will read these as redundant/cliché/non-compliant):** yield/DCA/trading/rebalancer bots; wrappers of first-party
plugins or core tools (swap, bridge, on-ramp, transfer, generic x402 gateway); $0.01 data/LLM wrappers; Amazon/Resy/flight/ticket
clones; card-checkout plugins (no card proposal type, PCI); another spend-policy/guardrail layer (PayBox is that); A2A/ERC-8004
marketplaces; Polymarket/Kalshi trading (EIP-712 + per-user secrets + IP geoblocks); custody or pooled funds; subscriptions via plugin;
multi-payment pipelines; anything needing schedulers or in-plugin state.

**Design laws for this runtime.** One hero approval per user action · thin plugin, smart backend (stable tool schemas; backend logic
keeps evolving after the upload lock since hosts/vars/secrets stay editable) · state on-chain or as backend handles · async submit→poll ·
exact, checkable plain-language summaries + post-tx verification (window shows raw bytes) · avoid EIP-7702/permit/x402 plain-EOA traps ·
no custody · explicit compliance/geo gating · demo host = Claude.ai connector (Grok draws window late; Claude Code may refuse).

## How the shortlist was produced
6 ideation lenses → 18 concepts → 15 after merging duplicates → 3 removed as infeasible for this builder (no corridor/KYB access)
→ 5 persona judges (PayBox eng lead, MoonPay product/GTM, compliance officer, veteran hackathon judge, security/mechanism engineer)
scored 12 on the weighted 1st-place rubric with live-E2E and compliance gates → top 5 red-teamed (pre-mortem, make-or-break
verification against primary sources, upgrades). Excluded on access only (would otherwise be strong): **Up NEPA/Homeline** (pay a
Nigerian prepaid-electricity token, charged only after the token is issued) and **Landed** (the missing PayBox off-ramp).

## The 5 candidate projects
| # | Project | One-liner | Judge score /100 (Borda) | Red-team verdict · P(1st) |
|---|---|---|---|---|
| 1 | **Keyframe** (Creative + Merchant) | Hire a motion designer from chat; one gasless tap seals USDC at an escrow address that *is* the deal; the studio is paid only by publishing the key to your file, else zero-tap refund | **74.2 (25 — #1 for all 5 judges)** | keep-with-changes · ~12% |
| 2 | **Safe co-signer** (Merchant/treasury) | Your PayBox wallet becomes a Safe/Squads signer that independently decodes, then co-signs + executes via Safe's `approveHash`/v=1 path — no EIP-712, no blind signing | 65.2 (14) | keep-with-changes · ~5% (deepest runtime insight, B2B-narrow, no tangible outcome) |
| 3 | **Proof of Life** (Consumer) | Allowance-as-a-will: one approval to a CREATE2 address encoding heirs; passkey check-ins are heartbeats | 60.2 (8) | keep-with-changes · ~3% (trope; heartbeat claim refuted — autonomous grants can sign) |
| 4 | **Payable** (Merchant) | Verified, exactly-once invoices any agent can pay; issuer-bound payees; look-alike refusal; books export | 60.0 (6) | keep-with-changes · ~6% (robust, but mechanism reads as hygiene; no visible outcome) |
| 5 | **Brier** (Predictions) | Paid forecasts refunded by a proper scoring rule, committed on-chain, Chainlink-settled | 59.0 (7) | **kill** · ~4% (event-contract/swap compliance risk; specced rule provably improper) |

Dimension means for Keyframe: usefulness 6.0 · PayBox depth 9.1 (slate-best) · originality 8.3 · demo 7.7 · robustness 6.6 · traction 4.7.

## Champion: Keyframe — pay-on-delivery for the agent economy, proven by a motion studio
**One sentence:** *Hire a motion designer from chat and pay only on delivery.*

**Why it wins (and why the others don't):**
- Only entry top-of-slate on both PayBox-native depth and originality while fully inside this builder's reach (no KYB, no
  counterparties, solo-natural: a studio founder demoing their own studio), with every gate passing for all 5 judges.
- Ships a real primitive into PayBox: x402 *auth-capture semantics* (escrow, void, refund) on the plain `exact` scheme with
  **one gasless passkey tap** — closing x402's most-cited gap (refunds/escrow) while facilitators still don't support auth-capture.
- Fills the empty Creative shelf with the builder's own human-designed motion system (settles the "meaningful human contribution"
  gate) and doubles as Merchant tooling: the escrow factory + middleware is MIT-licensed "pay-on-delivery for any x402 seller".
- MoonPay hook: *"MoonPay Commerce already makes payTo a per-payer deposit wallet that sweeps to the merchant; Keyframe makes that
  deposit address trustless."* Timely with MoonPay's Lumara AI Film Festival and the Oct-2026 rogue-agent news ("agent acts, human
  approves").
- ~95% of demo money recoverable (USDC cycles between the builder's wallets; only gas/hosting/render compute spent).

**Changes mandated by judges + red-team (all adopted):** key orders by URL (`POST /v1/orders/{quote_id}` — PayBox's unpaid probe
omits the body); one deterministic x402 version per 402; persistent CREATE2 clones (no SELFDESTRUCT runner); plugin-side proof
(derive E locally, assert `payTo == E`, decrypt + hash-check delivery); approved-keyframe hash in the terms + watermarked preview;
upto change + optional SLA decay; verify-then-settle + exactly-once; two refund keepers (Cloudflare Cron + KeeperHub); Instant +
Studio tiers with crypto-native formats (launch sting, portfolio card from `get_portfolio`, price chart, kinetic post); OFAC screening;
plain-English "sealed envelope" demo; open the 402 to every x402 client for real traction.

**Honest limits:** guarantees delivery/access, not quality (mitigated by preview + committed hashes); originality is HTLC/ZKCP
lineage applied to x402 (credit it); usefulness/traction were the weakest scores — addressed by formats agents already have data
for, the Studio (human) tier, and the open middleware.

## Build plan
Full design docs (architecture/contracts/plugin, product/render/demo, verification/build-order — ~150 KB, source-verified against
`@x402/*@2.28.0`, OZ, starter v1.0.2, HyperFrames) are the `.result[].doc` strings in
`/private/tmp/claude-501/-Users-oluwademilade-Desktop-paybox/025994f1-f93a-49c4-857a-bb9ba7e918e6/tasks/whl8d0uom.output`.
**Step 0 extracts them into `docs/design/{architecture,product-render-demo,verification}.md`** and archives the research
(`…/tasks/wthd1i451.output`), ideation (`…/tasks/w9yjneji7.output`) and judging (`…/tasks/wu9o33tlp.output`) corpora under
`docs/research/`, so execution never depends on /tmp.

### Reconciled architecture decisions
| Area | Decision (why) |
|---|---|
| Escrow | Ownerless, immutable `KeyframeEscrowFactory` on Base + persistent **OZ EIP-1167 clones** at `E = CREATE2(factory, termsHash, cloneInitCodeHash)`, deployed lazily on first money-moving call. No SELFDESTRUCT/transient-storage runner. Funds at any E can only ever reach `T.buyer` or `T.seller`. Caps 0.10–50 USDC. |
| Terms v1 (FROZEN) | `{buyer, seller, operator, token, amount, dueAt, deadline, reviewWindow, slaFloorBps, killFeeBps, keyHash, specHash, contentHash, salt}`; `termsHash` = EIP-712 digest (domain "Keyframe Escrow"/v1/8453/factory). `specHash = sha256(JCS(spec))` covers format, params, template version, key-frame still hash, `sha256(K_buyer)`. |
| Contract surface | `fundWithAuthorization` (**contract-as-facilitator**: EIP-3009 to E + register T atomically) · `register` (front-run/PayAI path) · `release(T,K,charge,manifestHash)` seller/operator only, `charge ≤ payoutAt(now)` (upto change + SLA decay, rest → buyer) · `cancel` (= void → buyer) · Studio `deliver` / `decide` / `decideBySig` (review window, kill fee) · `refund` (anyone after deadline) · `refundExpired(maxScan)` (keepers) · `sweep` (late/duplicate funds → buyer) · storage view `order(termsHash)` exposing state, K, hashes (plugin needs **no getLogs**). |
| Instant delivery | **Render-before-pay (ZKCP-lite):** quote returns a watermarked key-frame still in ≤ 4.5 s (draft), then finalizes with `contentHash` once the encrypted master + watermarked full preview exist (~30–60 s). The paid address commits to the exact encrypted file; release fires seconds after funding. Studio tier binds at delivery with a review window. |
| Encryption `KFC1` (FROZEN) | `K_file = HKDF-SHA256(K_chain‖K_buyer, salt=termsHash, info="keyframe/kfc1/file")`; AES-256-GCM 1 MiB chunks, counter nonces, AAD binds termsHash/index/total; JCS manifest (chunk + plaintext hashes, media meta). `K_chain` revealed on-chain to get paid; `K_buyer` only in the paid response (private mode) or SIWE re-delivery. |
| API | **Hono on Cloudflare Workers (Paid, $5)** + D1 (CAS exactly-once, job table) + **Durable Object relayer** (serialized nonces) + R2 (ciphertext/previews) + Cron (keeper #1). Uses `x402HTTPResourceServer` from `@x402/core` with `DynamicPayTo`/`DynamicPrice`, a custom adapter (canonical URL, forced `application/json` to dodge the HTML paywall), **one wire version** (v2 header; v1 emitter behind `X402_WIRE`), orders keyed by URL `POST /v1/orders/{quote_id}`, verify → business checks (payer == T.buyer, OFAC, capacity, deadline) → settle, idempotent replay by `(from, nonce)`. Self-facilitated; PayAI keyless fallback; never x402.org. |
| Render | **HyperFrames + ffmpeg finish** (builder already uses it — `/Users/oluwademilade/Desktop/ignix/video/hyperframes/HYPERFRAMES_NOTES.md`): `hyperframes render --docker --strict-variables --variables-file`, `snapshot --at` for stills, `check` + fast-check param fuzz as template QA. Primary: small pre-warmed VPS in Docker (Chrome + ffmpeg + CLI, no keys); fallback: builder's Mac via Cloudflare Tunnel. LLM fills typed params only. |
| Durability | Ciphertext on R2 + IPFS pin (Filebase/Pinata); static MIT `/open` page decrypts from chain + storage, so "even if our server vanished" is literally true. |
| Keepers | Cloudflare Cron (chain-only) + **KeeperHub** workflow (reuse Ripcord's `/Users/oluwademilade/Desktop/Ripcord/workflows/wf2-defend-mainnet.json` pattern: schedule → read `refundableCount` → condition → `refundExpired(20)`) + GitHub Actions overdue-escrow monitor + buyer `keyframe_refund` + `npx @keyframe/refund`. |
| Compliance | Off-chain OFAC SDN screening at quote and before settle (USDC blacklist is the token-level backstop; no in-contract oracle); content policy (no real-person likeness, brand-rights attestation); Keyframe escrows only its own first-party sales; disclose "unaudited, $50 cap"; never say "PayBox-verified" or "AI video generator". |

### Plugin (frozen at upload) — 9 tools, starter v1.0.2 tooling byte-identical
| Tool | Kind | Role |
|---|---|---|
| `keyframe_styles` | data | Formats, styles, prices, ETA, samples (embedded fallback catalog for offline) |
| `keyframe_quote` | data | Validate typed params → quote; plugin **re-derives E locally**, pre-fetches the 402 and asserts `payTo == E` & amount; checks buyer wallet (7702 prefix `0xef0100`, USDC/ETH); picks rail (x402 / direct / fund_first → core `get_buy_link`) |
| `keyframe_commission` | **x402** | `proposeX402` to `POST /v1/orders/{quote_id}`, `maxAmount = T.amount` (one gasless tap) |
| `keyframe_commission_direct` | **evm** | `USDC.transfer(E, amount)` for 7702-delegated wallets |
| `keyframe_status` | data | Order/quote progress (draft → final → SEALED → KEY PUBLISHED / RETURNED) |
| `keyframe_verify` | data | `derive` (offline; the conformance sample) · `funding` (E codeless/clone, balance, T) · `delivery` (reads K from `order()`, fetches ciphertext, decrypts with WebCrypto, checks hashes + MP4 duration/resolution) |
| `keyframe_refund` | **evm** | Buyer-side `refund`/`sweep`/reject fallback (keepers normally do it with zero taps) |
| `keyframe_review` | data | Studio accept / changes / reject via EIP-712 signed with core `request_wallet_sign` |
| `keyframe_orders` | data | SIWE (core `request_wallet_sign`) → list orders + `K_buyer` re-delivery in a new chat |

Hosts ≤ 5 of 16 (api, files, `mainnet.base.org`, a second Base RPC, IPFS gateway); env vars (editable post-lock): `KEYFRAME_API_BASE`, `KEYFRAME_FACTORIES` (allowlist with status), `KEYFRAME_SELLERS`, `KEYFRAME_RPC_URLS`, `KEYFRAME_MAX_AMOUNT`, `KEYFRAME_PRIMARY_RAIL`, `KEYFRAME_7702_POLICY`, `KEYFRAME_MAINTENANCE`. Proposal tools return only the starter's strict schemas; guidance lives in `content[].text`. Backend-sourced fields are loose objects so the server can evolve.

**Frozen at upload:** tool names/schemas/descriptions, Terms v1 + EIP-712 strings, CREATE2 derivation, ABI subset, KFC1, JCS spec, 402 parser (v1+v2), safety bounds, env-var names.
**Evolves after the lock:** prices, catalog, templates/styles, render pipeline, SLA policy, wire-version flag, facilitator, keepers, monitoring, hosts/secrets, factory redeploys (same ABI, allowlisted), open 402, traction surfaces.

### Product
| Format | Price (USDC) | Notes |
|---|---|---|
| Launch Sting (hero) | 4 (6 s) / 7 (10 s) | wordmark + tagline; demo order = Ripcord sting (brand: `/Users/oluwademilade/Desktop/Ripcord/docs/brand/BRAND.md`, `web/src/styles/tokens.css`) |
| Countdown | 1 | ≤ $1 so default x402 clients (cap `$1`) can buy; refund-demo SKU |
| Portfolio Pulse | 3 | fed verbatim by core `get_portfolio`; reads "24h move", never "PnL"; private delivery by default |
| Kinetic Post / Chart Moment | 3 / 5 | post-lock formats |
| Studio Sting / Spot (human) | 25 / 50 | bespoke by the builder, 48–72 h, 24 h review (accept / one change / reject = refund) |
| `probe` (hidden) | 0.10 | synthetic monitoring |

### Phases (scope not reduced; the only hard date is the upload lock, Sat Oct 17 8 pm EDT ≈ 22.8 h from planning time)
0. **Setup + no-money spikes** — `git init`; copy design docs; fetch starter and verify against its `manifest.json` checksums; PayBox wallets A (buyer, granted to Claude.ai), B (studio payout, never granted), C (7702 lab); relayer key (Workers secret) + deployer (Foundry keystore); Cloudflare, Alchemy, Etherscan v2. Spikes S1 (upload a diag + x402 plugin: WebCrypto, env vars, fetch sizes, brokered Alchemy header) and S2 (Validate an unpaid 402 with a per-order codeless payee; 402 byte-identical across probes). Portal submission workspace is already open (per screenshot).
1. **Money spikes** (all recoverable, swept back gaslessly) — S4 live $0.10 plugin order from Claude.ai (needs Submit Project → enable under Unofficial plugins); S5 v1/v2; S7 `get_request` body integrity; S8 paid re-fetch latency tolerance → settle mode (wait vs broadcast); S9 $8/$50 amounts; S10 7702 behaviour + direct rail. Record ADR-002/003/011/012.
2. **Freeze interfaces** — `packages/protocol` (Terms, EIP-712, derivation, KFC1, JCS, ABIs) + Solidity factory/vault with cross-language test vectors and fork tests → deploy + verify on Base → plugin 9 tools final (prompt-robustness suite ≥ 9/10 correct tool order) → API v1 (quotes, deterministic 402, paid path, status, orders, review/SIWE with frozen HTTP shapes) → Countdown + Launch Sting templates on the render box.
3. **Release candidate → submit (before the lock)** — upload RC → hosted checks → Test console (all tools) → Validate (x402 + both evm proposals) → Submit → Claude.ai mainnet E2E (happy path, deadline refund, keeper-down buyer refund, quote expiry) → final upload = the RC that passed (sha256 in `docs/RELEASES.md`) → **Submit Project**, tag `plugin-final`.
4. **Post-lock evolution (backend only)** — remaining formats/styles; Studio ops + review backend; keepers ×3 + monitors (synthetic hourly order via open 402, 402-drift probe, relayer balance, overdue escrows); Halmos + deep invariants + threat model + external review request; MIT `@keyframe/pod` middleware ("pay-on-delivery for any x402 seller", ~20 lines on stock `@x402/hono`) + README crediting HTLC/ZKCP; open 402 for every x402 client, single-URL order form, `llms.txt`/OpenAPI, `/live` on-chain counter, `/open` decrypt page.
5. **Film + launch** — 75–90 s X film in the builder's own voice (cold open on the real Ripcord sting → quote card + key frame → payee in PayBox window matches E → Basescan: address with no code holding USDC → release tx with the key in calldata + plugin decrypting → order #2 "studio paused", zero-tap refund → template-design timeline → "MoonPay Commerce gives every payer a deposit address; Keyframe makes it trustless" → credits-as-receipts end card). Edited as a HyperFrames project. Disclosure line: "buyer and studio wallets are both mine; real USDC, Base mainnet". "First 50 commissions, pay on delivery" thread; Lumara entrants + MoonPay Commerce memo via the winner GTM advisory. If organisers require the X video by the lock, post a 60 s proof cut from Phase 3's E2E run first.

### Submission copy (character counts verified)
- **Name (64/80):** `Keyframe: hire a motion designer from chat, pay only on delivery`
- **What it does (276/280, recommended):** "Hire a motion designer from chat, pay only on delivery. One PayBox tap seals your USDC at an escrow address computed
  from the deal and the exact file you previewed. The studio is paid only by publishing that file's key on Base before the deadline;
  otherwise it all comes back."
- Alt (264/280, more discovery keywords): "A human-designed motion studio agents can hire: launch stings, portfolio cards, countdowns, ready in minutes. You
  pay with one gasless tap into an escrow that pays us only if we publish your file's key on time, or else refunds you. Open-source for
  any x402 seller."

### Budget (≤ ~$100) and accounts (all individual, no KYB)
USDC float ~$55 (recoverable: cycles A → E → B, spike payees swept back) · Base ETH ~$9 for relayer/deployer/wallets (~$1–3 burned) ·
Cloudflare Workers Paid $5 · domain $10–15 · render VPS $5–25/mo · IPFS/KeeperHub/Alchemy/PayAI/Etherscan free tiers · irreversible
spend ≈ $25–45. Accounts: PayBox (+ MoonPay KYC, same email), Cloudflare, Alchemy, Etherscan v2, VPS, KeeperHub (existing org from
Ripcord), IPFS pinning, GitHub, X, Telegram bot.

### Human-contribution evidence (DQ guard)
Builder personally authors the motion language (`templates/_kit/MOTION.md`), every template, the escrow contract + invariants, the film and
voice. Repo keeps small commits, ADRs 001–015 in the builder's voice, `HUMAN_CONTRIBUTION.md`, `PRE-EXISTING.md` (Ripcord brand/fonts
disclosed), `FRICTION.md` + `EVIDENCE.md` (as in Ripcord), template design timelapses. Licences: contracts + packages MIT; templates
all-rights-reserved.

### Critical files
`plugin/src/plugin.ts`, `plugin/src/tools/*.ts`, `packages/protocol/src/terms.ts`, `contracts/src/KeyframeEscrowFactory.sol`,
`contracts/src/KeyframeVault.sol`, `api/src/x402/orders.ts`, `api/src/x402/facilitator.ts`, `render/worker/src/job.ts`,
`templates/launch-sting/`, `docs/design/frozen-interfaces.md`.
**Reuse:** starter `src/paybox.ts` (`proposeX402`, `proposeEvm`, `atomicAmount`, strict output schemas) and its `scripts/*`;
`@x402/core` (`x402HTTPResourceServer`, `DynamicPayTo`, `DynamicPrice`, `x402Facilitator`, `registerExactEvmScheme`), `@x402/fetch`
for interop tests; OpenZeppelin `Clones`, `EIP712`, `ReentrancyGuard`, `SafeERC20`; Base USDC `transferWithAuthorization`;
HyperFrames CLI; Ripcord's KeeperHub workflow JSON, brand tokens, FRICTION/EVIDENCE patterns; the already-logged-in `paybox` CLI
(`~/.config/paybox/config.json`) for catalog checks.

## Verification
- **Local gates:** `cd plugin && pnpm install --frozen-lockfile && pnpm --silent test | jq -e '.status=="passed"'` (typecheck, two
  byte-identical builds, conformance on the offline `keyframe_verify {mode:"derive"}` sample) · `pnpm unit` (vectors parity, 402 parser
  fuzz, adversarial backend stubs → no proposal, 7702 detection, KFC1 tamper, MP4 header, time budgets, no secrets in `dist/`) ·
  tool-catalog snapshot diff gate.
- **Contracts:** `forge test -vvv` (unit + fuzz 20k) · invariant campaign (funds at E only reach buyer/seller; seller paid only with K
  before deadline; ≤ amount; single terminal state; factory holds nothing; conservation) · fork tests on real Base USDC (EIP-3009 to a
  codeless E, front-run then `register`, SLA payout, refund by stranger, sweep, 7702 payer, blacklist/pause) · `halmos` properties ·
  `forge script … --broadcast --verify --chain 8453`, then `cast call computeAddress(T)` must equal the plugin's derivation.
- **402 determinism:** create a quote, fetch `/v1/orders/{q}` three times (POST/POST/GET) → identical `PAYMENT-REQUIRED` sha256;
  decoded `payTo` equals E and `cast code E` is `0x`.
- **Hosted:** portal checks green; Test console runs all 9 tools; Validate passes for the x402 proposal (payee E, amount) and both evm
  proposals.
- **Mainnet acceptance from Claude.ai** (each logged with request_ids + tx hashes in `docs/evidence/EVIDENCE.md` and passing the
  chain-only auditor `pnpm -C tools audit-order --terms-hash 0x…`, which re-derives E, checks the funding Transfer, `keccak(K)==keyHash`,
  payout split, decrypts the ciphertext and ffprobes the file without touching the API): happy path (1 approval), Cloudflare-keeper
  refund, KeeperHub refund, buyer self-refund, seller void, overpay/late-funds sweep, direct rail (7702), sanctions refusal (no tx),
  duplicate refusal, Studio review.
- **Release gate before final upload:** all of the above green except Halmos/deep invariants (may follow post-lock), uploaded sha256
  equals `RELEASES.md`, and the version shows **Submitted**, not just uploaded.

## Risks, unverified items and plan B
- Unverified until the spikes run: per-order codeless `payTo` on the *plugin* x402 path (doc-level yes; MoonPay Commerce does per-payer
  payTo), v2 header parsing, paid re-fetch timeout, plugin proposal amount limit, auto-undelegate on Base, `get_request` body integrity,
  upload-attempt limits, whether the X video must be posted before the lock.
- **Plan B if PayBox refuses a per-order payee:** primary rail becomes `keyframe_commission_direct` (`USDC.transfer(E)`, still one
  approval, needs a little ETH); x402 stays for every other client. Mechanism and story unchanged.
- Judging risks and mitigations: "niche/self-dealing" → crypto-native formats agents already have data for, Studio (human) tier, open
  middleware, real strangers' orders via the open 402; "AI video wrapper" read → lead with the escrow and visibly human-made templates;
  jargon → sealed-envelope metaphor with SEALED / KEY PUBLISHED / RETURNED states; originality challenge → credit HTLC/ZKCP and claim
  only "first pay-on-delivery that works with any x402 client paying exact USDC on Base, in one tap".
- **Fallback champion** if x402 interop fails catastrophically: Safe co-signer (#2) — no x402, no new contracts, highest robustness.
