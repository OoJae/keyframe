<!-- Source: keyframe-design workflow (wf_54984e8c-060), product-render-demo agent, 2026-10-17. Reconciled decisions live in docs/design/frozen-interfaces.md, which WINS on any conflict. -->

# Keyframe: product, motion pipeline and demo design

Perspective: product lead, motion-pipeline lead and demo director.
Clock: it is Fri 16 Oct, 20:42 EDT (Sat 01:42 WAT, the builder's local time). The bundle locks Sat 17 Oct at 20:00 EDT (Sun 01:00 WAT), about 23 h from now.

## 0. Decisions on one screen

1. **Product.** "Hire a motion designer from chat. Pay only on delivery." There are two tiers on the same escrow.
   - **Instant:** 5 hand-designed parametric formats, $2–7, usually delivered in under 2 min.
   - **Studio:** bespoke work by the human designer, $25 or $50 (the cap), 48–72 h, with a review before the key is revealed.
2. **Formats.** Launch order is Launch Sting (hero) → Countdown (cheapest, judge-test and refund-demo SKU) → Portfolio Pulse (fed by PayBox `get_portfolio`). Kinetic Post and Chart Moment follow. All 5 formats are in the schema tonight, but backends ship them as they are ready.
3. **Render stack.** HyperFrames templates plus an ffmpeg finishing stage. Remotion is not used.
   - Primary worker: one pre-warmed 4 vCPU / 8 GB VPS in Docker.
   - Secondary worker: the builder's Mac (same container), used for demo speed and failover.
   - Overflow: HeyGen-hosted `hyperframes cloud render`, public-mode orders only.
4. **Lock-critical.** Tool names, input/output schemas and the plugin's own text templates freeze tonight. Prices, catalog, styles, templates, hosts and the factory allowlist stay server-side or in env vars and keep evolving.
5. **Film.** 86 s in the builder's own voice. Cold open on a real Ripcord sting. Three explorer proofs: an address with no code holding USDC, the release tx with the key in calldata, and a keeper refund with 0 taps. Solo disclosure on screen at the first money beat.

---

## A. Product surface

### A1. Vocabulary (use everywhere: tool text, film, site)

| Concept | User-facing word | Technical (details only) |
|---|---|---|
| Escrow address E | "sealed envelope" | CREATE2(factory, keccak256(abi.encode(T)), cloneInitCodeHash) |
| Terms T | "the deal" | struct incl. keyHash, keyframeHash, specHash, deadline |
| K (K_chain) | "the key to your file" | preimage of keyHash, published in `release` |
| Funded | **SEALED** | USDC Transfer buyer→E, E has no code |
| Released | **KEY PUBLISHED** | `release(T,K,…)`, clone deployed, seller paid |
| Refunded / voided | **RETURNED** | `refund(T)` after deadline (anyone) / `void(T)` (seller) |
| SLA partial (if contract has decay) | "PART-RETURNED" | release pays decayed share, rest to buyer |

**One-sentence metaphor:** "Your payment waits in a sealed envelope that opens only two ways. Either the studio hands you the key to your video (then they're paid), or the deadline passes (then it comes back to you, automatically)."

**Honesty line (fixed copy):** "We guarantee you get the file you approved, on time, or your money back. We can't guarantee you'll love it. That's why you see the key frame before you pay, and why Studio orders have a review."

**Never say:** "AI video generator", "PayBox-verified", "audited", "first ever" (in the README only, write "to our knowledge, the first pay-on-delivery that works with any x402 client paying exact USDC on Base, in one tap").

### A2. Instant catalog

Defaults for every Instant format:
- 30 fps, H.264 High, yuv420p, AAC 48 kHz (or no audio track).
- Aspects: 9:16 = 1080×1920, 1:1 = 1080×1080, 16:9 = 1920×1080.
- Default deadline is 30 min after the quote's 5-min payment window.
- No free-text prompts. The LLM fills typed fields only.

| # | Format id | What | Duration | Price (USDC) | Hero frame (still) | Launch |
|---|---|---|---|---|---|---|
| F1 | `launch_sting` | Wordmark/logo + tagline brand sting | 6 s or 10 s | 4.00 / 7.00 | 3.4 s / 5.0 s (lockup legible) | tonight, 2 styles |
| F2 | `countdown` | "T-minus" launch card, seconds tick for the clip | 8 s | 2.00 | 3.0 s | tonight, 1 style |
| F3 | `portfolio_pulse` | Portfolio card from PayBox `get_portfolio`: 24h price move of current holdings + top 5 | 8 s | 3.00 | 5.8 s (all values landed) | tonight, 1 style (+"Rekt" style post-lock) |
| F4 | `kinetic_post` | Your own announcement text as kinetic type (no X logo/UI trade dress) | 6/9/12/15 s chosen server-side by word count (≤12/≤22/≤34/≤50 words) | 3.00 | last line landed + 0.5 s | post-lock |
| F5 | `chart_moment` | Animated price line + callout; data fetched by backend at quote time, snapshot hashed into spec | 10 s | 5.00 | 7.5 s (line drawn + callout) | post-lock |
| — | `probe` (hidden) | 2-s test card for synthetic monitoring | 2 s | 0.10 | 1.0 s | tonight |

Honesty notes:
- `get_portfolio` exposes per-holding `priceChange24h` and USD balances, not cost basis. The card therefore reads "24h move of current holdings", never "PnL". Portfolio change = (Σusd − Σ usd/(1+c)) / Σ usd/(1+c), with unpriced holdings excluded and shown as "—".
- Charts never use LLM-supplied numbers.

### A3. `keyframe_quote` input schema (freeze tonight)

Rules for the schema:
- Top level must be a plain object; a top-level `oneOf` risks host incompatibility.
- `params` is an `anyOf` of strict per-format objects. The plugin `superRefine`s that `format` and `params` agree.
- Style and asset fields are strings, validated server-side against the live catalog, so new styles and assets need no new bundle.
- New formats added after the lock go through `format: "catalog"`.

```ts
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hex6 = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const Palette = z.union([z.enum(["void","paper","signal","mono","ember"]),          // builder-designed, contrast-checked presets
                         z.object({ bg: Hex6, fg: Hex6, accent: Hex6 }).strict()]);  // server enforces WCAG ≥4.5:1 fg/bg
QuoteInput = z.object({
  buyer: Addr,                                   // PayBox wallet that will pay (list_credentials → metadata.address)
  format: z.enum(["launch_sting","countdown","portfolio_pulse","kinetic_post","chart_moment","studio","catalog"]),
  aspect: z.enum(["9:16","1:1","16:9"]).default("9:16"),
  palette: Palette.optional(),                   // omit → style default; never invent brand colors
  deadline_minutes: z.number().int().min(5).max(1440).default(30),   // Instant only
  delivery: z.enum(["public","private"]).optional(),  // default public; portfolio_pulse defaults private (split key)
  receipt_end_card: z.boolean().default(true),   // 1.2 s "credits are receipts" card
  sound: z.enum(["none","studio"]).default("studio"),
  rights_confirmed: z.literal(true),             // user owns/may use names, logos, text; no real-person likeness
  params: z.union([
    /* launch_sting   */ z.object({ style: z.string().max(32), wordmark: z.string().min(1).max(24),
                           tagline: z.string().max(60).optional(), logo_url: z.url().max(512).optional(), // https png/webp/svg ≤2 MB
                           duration_s: z.union([z.literal(6), z.literal(10)]).default(6) }).strict(),
    /* countdown      */ z.object({ style: z.string().max(32), label: z.string().min(1).max(32),
                           target: z.iso.datetime(), cta: z.string().max(24).optional(), tz_label: z.string().max(12).optional() }).strict(),
    /* portfolio_pulse*/ z.object({ style: z.string().max(32), title: z.string().max(32).optional(), handle: z.string().max(24).optional(),
                           display: z.enum(["percent_only","values"]).default("percent_only"), as_of: z.iso.datetime(),
                           portfolio: z.json().optional(),     // get_portfolio result, VERBATIM (preferred)
                           holdings: z.array(z.object({ symbol: z.string().max(12), usd: z.number().nonnegative().optional(),
                                       change_24h: z.number().min(-1).max(1000).nullable() }).strict()).max(6).optional() }).strict(),
    /* kinetic_post   */ z.object({ style: z.string().max(32), text: z.string().min(1).max(280),
                           byline: z.string().max(32).optional(), emphasis: z.array(z.string().max(24)).max(5).optional() }).strict(),
    /* chart_moment   */ z.object({ style: z.string().max(32), asset: z.string().max(80),   // "ETH" or "base:0x…"
                           window: z.enum(["24h","7d","30d","90d","1y"]), callout: z.string().max(40).optional(),
                           mark: z.enum(["change","high","low","none"]).default("change") }).strict(),
    /* studio         */ z.object({ deliverable: z.enum(["studio_sting","studio_spot"]), brief: z.string().min(40).max(2000),
                           references: z.array(z.url()).max(5).optional(), brand_assets_url: z.url().optional() }).strict(),
    /* catalog        */ z.object({ catalog_id: z.string().regex(/^[a-z0-9_.-]{2,64}$/), values: z.record(z.string(), z.json()) }).strict(),
  ]),
}).strict();
```

**Output-schema rule.** Fields that come from the backend (`terms`, `details`, `catalog` items) are loose objects (`z.looseObject` / `z.record`), so the server can evolve them after the lock. Only the plugin's own check results are strict. The x402 and EVM tools return exactly the starter's strict proposal schemas, so all their guidance goes in `content[0].text`.

### A4. Studio tier (human, bespoke)

| SKU | Price (fixed, ≤ $50 cap) | Deliverable | Delivery SLA |
|---|---|---|---|
| `studio_sting` | 25.00 | custom 6–10 s logo/brand sting, 1 aspect | watermarked preview within 48 h of payment |
| `studio_spot` | 50.00 | custom 15–20 s piece, 1 aspect, style frame first | watermarked preview within 72 h |

The flow:
1. Quote. T has `keyframeHash = 0` and `specHash = hash(brief JSON)`. There is a review window; nothing is rendered before payment.
2. One-tap payment. This is the same `keyframe_commission` tool and the same envelope.
3. **Acceptance within 12 h.** Studio hours are 09:00–21:00 WAT (08:00–20:00 UTC). If the order isn't accepted, the backend calls `void(T)` and the buyer is refunded. The builder is notified by a Telegram/email bot and uses an admin CLI: `kf studio inbox | accept <id> | decline <id> --reason`.
4. **Style frame within 24 h of acceptance** (Spot only). This is an off-chain, watermarked still.
5. **Delivery.** `kf studio deliver <id> master.mp4` checks specs, encrypts, uploads the ciphertext, makes a 540p watermarked full-length preview, and records the delivery on-chain (`deliver(T, ciphertextHash, plaintextHash, previewHash)`).
6. **Review, 24 h.** The buyer, through `keyframe_review`, can:
   - **accept**: the key is published now and the designer is paid;
   - **changes**: one revision, which the designer re-delivers within 24 h, restarting review;
   - **reject**: a full refund.
   Silence counts as accept. Not delivered by the SLA means anyone can refund.
7. **Contract dependency.** If the first factory lacks `deliver/accept/reject`, Studio v1 runs with Instant semantics plus a disclosed off-chain promise not to publish the key before acceptance or the 24 h review end. Studio v1.1 moves to a new factory, which the plugin picks up through an env-var allowlist. The `keyframe_review` schema ships tonight either way.

The $50 tier depends on the undocumented plugin proposal amount limit. If the day-1 $50 probe fails, Studio uses `keyframe_commission_direct` or drops to $25.

### A5. Tool surface (9 tools; titles are numbered to sequence the LLM)

Descriptions are factual documentation, not commands; PayBox treats them as untrusted labels.

| Tool | Kind | Title |
|---|---|---|
| `keyframe_styles` | data | Keyframe · browse formats and prices (free) |
| `keyframe_quote` | data | Keyframe · 1. quote an order (free) |
| `keyframe_commission` | x402 | Keyframe · 2. pay into escrow (1 approval) |
| `keyframe_commission_direct` | evm | Keyframe · 2b. pay by direct transfer (1 approval, needs ETH gas) |
| `keyframe_status` | data | Keyframe · 3. check an order (free) |
| `keyframe_verify` | data | Keyframe · 4. verify delivery independently (free) |
| `keyframe_refund` | evm | Keyframe · return funds after deadline (fallback) |
| `keyframe_review` | data | Keyframe · Studio review: accept, changes or reject |
| `keyframe_orders` | data | Keyframe · find my orders (free) |

Description strings:

- **keyframe_styles:** "Lists what Keyframe Studio makes and what it costs: formats (launch sting, countdown, portfolio card, kinetic post, price-chart moment, and human Studio commissions), styles, aspect ratios, durations, prices in USDC on Base, typical delivery time, current queue and sample video links. Every template is designed by hand by Keyframe's designer; agents only fill typed fields. Free; moves no money. If the user already said what they want, go straight to keyframe_quote."
- **keyframe_quote:** "Prices an order and prepares its pay-on-delivery escrow. Fill only the typed fields; omit optional fields rather than inventing names, colors or numbers the user did not give. buyer is the address of the PayBox wallet that will pay (list_credentials → metadata.address). For portfolio_pulse, first call get_portfolio for that address and pass its result unchanged as params.portfolio. Returns price, delivery time, deadline, a watermarked preview of the key frame, the escrow address (derived from the deal terms and re-checked by this plugin) and the payment route for this wallet. Moves no money. Show the user the price, deadline, preview link and escrow address. Next: the tool named in next.tool. If status is preview_pending, call keyframe_status with quote_id after retry_after_ms."
- **keyframe_commission:** "Creates the payment for a quote as one PayBox approval: an x402 payment of the quoted USDC on Base, gasless for the payer. The money goes to the order's escrow address, never to Keyframe directly. It can pay the studio only if the studio publishes the key to the buyer's file before the deadline; otherwise it can only return to the buyer, automatically. Before proposing, this plugin re-derives the escrow address and checks that the live payment request pays exactly that address and amount. Input: quote_id (valid 5 minutes). Use the wallet_id of the quote's buyer wallet. PayBox shows the payee and amount for approval. After approval, poll get_request until it finishes; never call this tool twice for one quote. Then call keyframe_verify with the paid response."
- **keyframe_commission_direct:** "Payment route for wallets that cannot pay by x402 (for example EIP-7702-delegated wallets). Use only when keyframe_quote returns route.kind = 'direct'. Proposes one Base transaction: USDC.transfer(escrow address, exact price). PayBox's window shows the USDC contract as 'to'; the escrow address and amount are inside the data. Needs a little ETH on Base for gas. Poll get_request to success, then call keyframe_verify with quote_id and tx_hash."
- **keyframe_status:** "Order progress: preview ready, sealed (paid into escrow), rendering (percent and time left), key published (delivered and paid), returned (refunded) or void. Accepts quote_id (this also finalizes a quote whose preview was pending) or order_id (+ access_token for private orders). Waits up to wait_s seconds (max 6) for a change. Free; moves no money. While rendering, call again after poll_after_s. When the state is key_published or returned, call keyframe_verify."
- **keyframe_verify:** "Proves an order's state from Base and public storage instead of trusting Keyframe's server. It recomputes the escrow address from the terms and checks the funding transfer and the escrow's balance and code. After delivery it reads the key from the on-chain release event, downloads the encrypted file, decrypts it here, and checks its fingerprint, length and resolution against the terms. Accepts the paid response from get_request, or quote_id/order_id (+ tx_hash for direct payments). Free; moves no money. Report each check to the user."
- **keyframe_refund:** "Fallback only. Refunds are automatic: after the deadline, Keyframe's keepers (or anyone) return the escrowed USDC to the buyer. If keyframe_status still shows funds in escrow after the deadline, this proposes the same public refund call from the buyer's wallet (one approval, needs a little ETH on Base). The money can only go to the buyer."
- **keyframe_review:** "For Studio orders whose watermarked preview is ready. decision: accept (pay the designer now), changes (one revision) or reject (full refund). The first call returns an EIP-712 message. Confirm with the user, sign it with request_wallet_sign (no gas; moves no money by itself), then call again with the signature. Doing nothing until the review window ends counts as accept."
- **keyframe_orders:** "Lists a buyer's Keyframe orders with fresh access links, for use in a new chat. The first call returns a sign-in message (EIP-4361) for request_wallet_sign; call again with the signature. Free; moves no money."

**Quote output.** It carries `status`, `quote_id`, `summary`, `price{usdc,atomic}`, `eta_s`, `quote_expires_at`, `deadline`, `preview{still_url, sha256, frame_time_s}`, `escrow{address, has_code, derivation{factory, init_code_hash, salt}}`, `terms` (loose), and `route{kind: x402|direct|fund_first, reason, wallet{plain_eoa, usdc, eth_wei}}`. It also carries `checks[]` and `next{tool, input, note}`.

The plugin performs these checks itself:
1. E is recomputed with CREATE2 locally.
2. The prefetched live 402 has payTo == E and amount == price.
3. The preview image's sha256 == T.keyframeHash.
4. The wallet's `eth_getCode` shows no `0xef0100` prefix, and its USDC and ETH balances are read.
5. The factory is in the `KEYFRAME_FACTORIES` env allowlist.

**Quote card text** (`content[0].text`, frozen in the bundle):
```
Keyframe quote KF-7Q2M: Launch Sting · Instrument style · 9:16 · 6 s
Price 4.00 USDC on Base · usually ready in ~1 min · deadline 14:32 UTC (miss it → full refund, automatic)
Key frame preview (watermarked): https://files.<domain>/p/KF-7Q2M.webp
Sealed envelope: 0xE5c1…9A3f (full: 0xE5c1b0…9A3f). Nothing is deployed there yet. The address is computed from this
deal, so the money can pay the studio only if the key to your file is published before the deadline; otherwise it can
only come back to you.
Checks by this plugin: address recomputed ✓ · live payment request pays exactly 4.00 USDC to it ✓ · preview matches the deal ✓
Wallet 0x70a0…2b1f: plain wallet, 12.40 USDC → route: x402 (one approval, no gas)
Next: keyframe_commission {quote_id:"KF-7Q2M"}. PayBox will show payee 0xE5c1…9A3f and 4.00 USDC; they must match.
```

The 402's `resource` fields are deterministic and identical on every fetch, with no timestamps:
- `serviceName`: "Keyframe Studio"
- `description`: "Order KF-7Q2M: Launch Sting 6s 9:16. Pay-on-delivery escrow 0xE5c1…9A3f; refundable after 2026-10-18 14:32 UTC."

### A6. Agent conversation design (hero flow + branches)

| Step | Calls | What the agent should say (shaped by tool text) |
|---|---|---|
| Ask | user | "Make a 6-second vertical launch sting for Ripcord. Use our wordmark (oojae.github.io/ripcord/brand/wordmark.svg), void black and blaze orange #FF4F00, tagline 'Agents decide. Ripcord lands the rescue.' Up to $5, go ahead." |
| Quote | `list_credentials` → `discover_plugins` → `keyframe_quote` | Price, ETA, deadline, preview link, the envelope sentence, "It's under your $5 limit, so I'm sending the payment request. PayBox will ask you to approve 4.00 USDC to 0xE5c1…9A3f, which is the envelope, not Keyframe's wallet." |
| Pay | `keyframe_commission` → PayBox window → `get_request` (poll) | (after approval) "Paid. Checking it independently…" |
| SEALED | `keyframe_verify(paid_response)` | "Sealed. 4.00 USDC is at 0xE5c1…9A3f, where no contract exists yet; the address itself is the deal. Rendering now (~1 min)." |
| Render | `keyframe_status(wait_s:6)` ×N | "Rendering 60%, about 20 s left." |
| KEY PUBLISHED | `keyframe_verify` | "Delivered, and checked by the plugin rather than taken on the studio's word: ✓ key published on Base (tx 0x9b…) and the studio paid 4.00 USDC · ✓ key matches the hash in your deal · ✓ file decrypts; fingerprint, 6.0 s, 1080×1920 match. Download: … Even if Keyframe vanished, the on-chain key plus the public encrypted copy still open your file: …/open#…" |
| RETURNED | `keyframe_status` / `keyframe_verify` | "Order KF-… missed its 14:32 deadline. Keyframe's keeper sent your 2.00 USDC back (tx 0x…). You didn't need to do anything." |

Branches:
- **Delegated wallet (7702) with ETH:**
  - Agent says: "Your wallet is in smart-account mode, which x402 can't pay from, so I'll use a direct USDC transfer to the same envelope: one approval and a fraction of a cent of ETH for gas."
  - The approval window will show `to = USDC 0x8335…2913`, with E inside the data.
- **Delegated wallet without ETH:** try x402 first, since PayBox may auto-undelegate. If it errors, offer `get_buy_link` for ETH, or the user can switch wallets.
- **USDC shortfall:** "You have 1.20 USDC; this costs 4.00." Then offer a `get_buy_link` (MoonPay's minimum purchase may exceed the shortfall; UNVERIFIED) or a cheaper format.
- **Solana-only USDC:** suggest core `request_swap` to Base USDC first (a separate approval).
- **preview_pending:** "Rendering your key-frame preview, one moment," then `keyframe_status({quote_id})`.
- **Content-policy reject:** "Keyframe can't make this: it names a real person or a brand you haven't confirmed. Want to change the wording?"
- **Capacity, wrong payer or duplicate:** the paid retry returns ≥400 with no settlement. "You were not charged: [studio at capacity / paying wallet ≠ quoted buyer / quote already paid]."
- **Portfolio card:** `list_credentials` → `get_portfolio(address)` → `keyframe_quote(params.portfolio = result verbatim, display percent_only)`. This is the PayBox-native composition beat.
- **Studio:** "Studio orders are made by hand by Keyframe's designer, one human: $25, preview within 48 h, then 24 h to accept, ask for one change, or reject for a full refund. Your money waits in the same kind of sealed envelope."

---

## B. Render pipeline

### B1. Framework evaluation → **HyperFrames + ffmpeg finishing**

| Criterion | HyperFrames | Remotion | raw ffmpeg |
|---|---|---|---|
| Authoring | HTML/CSS + one paused GSAP timeline (web-motion lingua franca); Lottie adapter for AE-made parts; Studio timeline editor for hand edits | React, frame-based interpolate/spring; Studio props editor | filtergraph expressions, drawtext |
| Typed params | `data-composition-variables` (string/number/color/boolean/enum); `--variables-file --strict-variables`; batch | `inputProps` + zod schema | none |
| Determinism | seek-per-frame; lint bans clocks/unseeded random/network; `--docker` documented as byte-identical (UNVERIFIED on our templates; builder's notes: local renders ≈50 dB PSNR, not bit-exact) | frame-pure | exact |
| Quote-time still | `snapshot --at` CLI (spawns Chrome per call; est. 2–5 s on VPS; no documented `--variables`) | `renderStill()` with a reused browser (sub-second) | instant, low craft |
| Built-in QA | `check`: lint + runtime + layout overflow + WCAG contrast | none | none |
| Speed (builder's Mac, measured) | 6 s 1080p30: 13.3 s `looks`, 7.1 s `draft`, 10.5 s `--gpu` | same class (Chrome capture) | ~1–2 s |
| Infra paths | local, Docker, Cloud Run, Lambda, HeyGen cloud | local, Lambda | anywhere |
| License | Apache-2.0 (package.json) | free for individuals/≤3-person companies (verify) | LGPL/GPL |
| Builder fit | used it on the ignix film; has measured notes (`/Users/oluwademilade/Desktop/ignix/video/hyperframes/HYPERFRAMES_NOTES.md`) | no evidence of use | familiar |

Remotion's real advantage is fast programmatic stills. The plan absorbs that gap with the two-call quote path (A5) and a warm-page spike (B4). Mixing two frameworks would be worse.

### B2. Template system (where the human craft shows)

```
/Users/oluwademilade/Desktop/paybox/
  packages/catalog/     zod format schemas, prices, policy, canonical spec + specHash, toTemplateVars()  (shared: plugin, backend, worker)
  templates/_kit/       MOTION.md tokens (type scale, palettes, named eases kf.lift/kf.seal/kf.settle as CustomEase),
                        glyphs (envelope, seal, key, clock, hash-glyph), OFL fonts (local @font-face), SFX (pre-normalized −16 LUFS wav),
                        watermark tiles (1080×1920 / 1080×1080 / 1920×1080 PNG)
  templates/_endcard/   "credits are receipts" sub-composition (envelope addr, funding tx, designer credit)
  templates/<format>/   template.json · index.tmpl.html · styles/<style>.{css,js} · design/ (storyboards, style frames, NOTES.md)
  render-worker/        Node 24 + pino; Dockerfile pins hyperframes (0.8.140 or current) + `hyperframes browser ensure` + ffmpeg
  tools/template-qa/    fast-check param fuzz → stills + `hyperframes check` → contact sheet for human review
```

Template mechanics:
- `template.json` declares id, semver, per-aspect sizes, durations, `heroTime` per duration, fps, a perf budget, and the variable list. `templateHash` is the sha256 of a deterministic tarball of the template, excluding `design/`.
- **Root `data-duration`, `data-width` and `data-height` are fixed at compile time** (they can't be set via variables). So the worker stamps them into a per-job `index.html` from `index.tmpl.html`.
- Arrays go in as JSON-string variables, parsed once at init.
- Text is sized with `window.__hyperframes.fitTextFontSize`.
- Texture and grain come from a seeded PRNG with seed = first 4 bytes of `specHash`. Each piece is unique but reproducible, and there's no circularity with T.
- **Acceptance gates for every template:**
  1. `hyperframes check` passes for 200 fast-check-generated param sets (longest/shortest wordmark, −99.9%/+10,000%, long words, etc.).
  2. The builder personally reviews the contact sheet.
  3. Perf budget: 6 s 1080×1920 renders in ≤45 s on the VPS.
  4. Only transform/opacity animation on large layers, with no animated full-frame blur.
- No registry blocks in shipped templates (the human-craft rule). The X-post block is excluded anyway because of trade dress. Any reuse is disclosed in `PRE-EXISTING.md`.

### B3. Param chain (LLM fills typed fields only)

1. Agent fills fields.
2. Plugin zod (strict) validates.
3. Backend runs the same zod plus policy:
   - denylist checks and glyph coverage against the shipped fonts' cmaps (in the backend, not the locked schema);
   - logo fetch: https only, ≤2 MB, png/webp/svg; SVG sanitized and rasterized with resvg on the worker; a lightweight face detector rejects likenesses;
   - optional LLM moderation, which runs before settlement rather than blocking the quote.
4. `toTemplateVars()`.
5. `--variables-file` with `--strict-variables`.

The data snapshot (portfolio or chart series) is frozen at quote time, stored content-addressed, and included in `specHash`. Charts come from Coinbase Exchange public candles for majors and DefiLlama for `chain:address` (both endpoints UNVERIFIED; check day 1).

### B4. Quote-time still ("approved key frame")

1. The backend creates the per-job dir and stamps it with the params as variable defaults (`snapshot` has no documented `--variables`).
2. It runs `HYPERFRAMES_NO_TELEMETRY=1 hyperframes snapshot <job> --at <heroTime> --output <job>/still --describe false`.
3. sharp composites the builder-designed tile watermark ("KEYFRAME · PREVIEW · KF-7Q2M", ~20% opacity) plus a corner badge "sealed until paid", and encodes WebP at q80 and half size.
4. It uploads the result to `files.<domain>/p/<quote>.webp`.
5. `T.keyframeHash` = sha256 of exactly those served bytes. The plugin re-hashes them.

Latency and fallback:
- The backend waits up to 4.5 s for the still. If it isn't ready, it returns `preview_pending`, and `keyframe_status({quote_id})` finalizes the quote.
- Stills run on a dedicated lane (1 Chrome) so they never queue behind renders.
- **Spike after the lock:** a warm Playwright page that loads the compiled composition and seeks to `heroTime` (target <1.5 s; UNVERIFIED feasibility).
- Rate limits: 30 stills/min globally and 10/h per buyer, with identical-spec caching.
- At delivery, the worker extracts the master's frame at `heroTime` and compares SSIM ≥0.97 against the unwatermarked still. This is a logged self-check, not trustless.

### B5. Render job lifecycle (worker)

The worker starts only after the funding receipt confirms. The paid response returned within ~2 s with the tx hash only.

```bash
hyperframes render /jobs/$ID --fps 30 --crf 20 --variables-file /jobs/$ID/vars.json --strict-variables --strict \
  --workers 3 --output /jobs/$ID/raw.mp4                                   # env HYPERFRAMES_NO_TELEMETRY=1
ffmpeg -i raw.mp4 -c copy -movflags +faststart master.mp4                  # remux only; no second encode
ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate,codec_name -of json master.mp4  # assert vs spec ±1 frame
ffmpeg -ss $HERO -i master.mp4 -frames:v 1 hero.png                        # SSIM self-check vs still
kfc pack master.mp4 --terms $TERMS_HASH --key-file key.bin > master.kfc    # B6
```

Then:
1. Upload to R2 (content-addressed) and the durable mirror.
2. `POST /internal/jobs/$ID/done {plaintextHash, ciphertextHash, uris, meta}`.
3. The backend relayer calls `release(T, K, ciphertextHash, plaintextHash)`.
4. In public mode, it also publishes the plaintext at `files.<domain>/v/<order>.mp4`.
5. `receipt.json` (funding tx, release tx, hashes, template id/version, designer) is published and pinned.

Size target is ≤8 MB with a 6 Mb/s cap; flat motion graphics typically land at 1–4 Mb/s. Studio masters are allowed up to 32 MB and use sampled-chunk verification.

**Never on buyer content:** `hyperframes feedback`, `publish`, or `cloud` (except the disclosed public-mode overflow).

### B6. Encryption container `KFC1` (plugin decrypts with WebCrypto)

- File key: `fileKey = HKDF-SHA256(ikm = K_chain ‖ K_buyer?, salt = termsHash, info = "keyframe/kfc1/file")`. Private mode adds `K_buyer`, which is returned only in the paid response; T carries `sha256(K_buyer)` so the plugin can check it.
- Header: `"KFC1" | u8 ver | u32 chunkSize (1 MiB) | u64 plaintextLen | termsHash`.
- Each chunk is AES-256-GCM. The nonce is `0x00000000 ‖ u64be(i)` and is not stored. `AAD = "KFC1" ‖ termsHash ‖ u64be(i) ‖ u8(isFinal)`, which blocks reorder and truncation.
- Hashes: `ciphertextHash = sha256(file)`, which is also the R2 object name; `plaintextHash = sha256(mp4)`.

**Verification in the plugin:**
1. Fetch from R2, falling back to the mirror.
2. Check sha256 of the container.
3. Decrypt all chunks.
4. Check sha256 of the plaintext.
5. Parse `mvhd`, `tkhd`, `stsd` and `stts` from the first chunk (faststart puts moov there) to get duration, size, codec and fps.

**"Even if our server vanished":**
- Ciphertext is on R2 plus a durable mirror: Arweave via Turbo, or an IPFS pin (pricing UNVERIFIED; about $0.05 per 6 MB order).
- A static MIT `/open` page, mirrored on GitHub Pages and IPFS, reads the Released event over public RPC, fetches by hash, and decrypts in the browser. Keys travel only in the URL fragment.

**Plugin hosts (≤16):** `api.<domain>`, `files.<domain>`, mirror gateway, Base RPC.

### B7. Infrastructure

| Option | 6 s 9:16 latency | Cold start | Cost | Verdict |
|---|---|---|---|---|
| Builder's Mac via Cloudflare Tunnel | ~15–20 s (measured class) | none | $0 | second worker + demo-take speed; never the only worker (laptop/power/ISP availability) |
| **Pre-warmed VPS, 4 vCPU / 8 GB, Docker** | est. 30–60 s (software GL; benchmark day 1) | none | ~$10–25/mo (UNVERIFIED vendor pricing) | **Primary** |
| Cloud Run (`hyperframes cloudrun`) | est. 30–60 s | 5–15 s, or a paid min-instance | ~$0 idle | Terraform + Workflows overhead; skip |
| Lambda (`hyperframes lambda`) | chunked; the docs say it isn't worth it for short clips | cold | per use | skip |
| HeyGen `cloud render --asset-id … --no-wait --callback-url` | queue + upload (UNVERIFIED) | n/a | per credit (UNVERIFIED) | manual overflow, public orders only |

Topology and operations:
- The Worker (Hono on Cloudflare) calls `render.<domain>` and `render2.<domain>` (Mac) through Cloudflare Tunnel with an Access service token. It picks the healthy worker with the shortest queue.
- Lanes: 1 still lane and 1 render lane (`--workers 3`).
- Capacity gates settlement (verify-then-settle).
- Monitoring: a local warm render every 15 min (no chain cost); an hourly on-chain $0.10 `probe` order from a third, monitoring wallet; Telegram alerts on 402 byte-drift, latency or relayer balance.

### B8. Budget (≤ $100; the float is recoverable)

| Item | Est. | Recoverable |
|---|---|---|
| Domain | $10–15 | no |
| VPS, 1 month | $10–25 | no |
| Cloudflare (Workers/D1/R2/Tunnel) | $0–5 | no |
| Base gas: deploy + ~150 txs + hourly probes for 14 d | $8–15 | no |
| Durable storage | $0–5 | no |
| Moderation API (optional) | $0–2 | no |
| USDC float (incl. one $50 Studio probe) + relayer/keeper ETH | $60 + $5 | yes |

Irreversible spend is about $30–65.

---

## C. The X film (86 s, 1920×1080, burned captions, builder's own voice)

**Motion language** (defined by the builder in `design/MOTION.md`; the roles below are mine, the values are theirs). It follows their Ripcord rule: state colors appear only when the state is real.

**SEALED (amber), 1.4 s:**
- The coin arcs from the wallet card to the envelope ("travel" ease, 0.7 s).
- The flap folds ("seal" ease, 0.45 s, small overshoot settle).
- The wax seal stamps in (scale 1.4→1, 0.25 s). Its 5×5 mirrored hash-glyph is drawn from `keyHash`.

**KEY PUBLISHED (green, never shown before a real release), 1.6 s:**
- A key glyph whose pattern is the hash-glyph of keccak(K) slides in and visually matches the seal.
- It turns 90°, the seal splits, and the video slides out of the envelope to full frame.
- The coin travels on to the studio card.
- This is an honest picture of the hash-lock.

**RETURNED (blue-neutral), 1.2 s:** the clock sweeps, the envelope tilts back, the coin retraces its arc, and the stamp reads "RETURNED · 0 taps".

**Sound and type:** builder-made SFX (thock / tick / reverse whoosh). Hashes and amounts are always set in mono.

| Time | Picture | VO (own voice) / captions | Proof |
|---|---|---|---|
| 0:00–0:05 | Ripcord sting (real order) plays in a 9:16 frame; it shrinks into the envelope mark | (0:02.5) "An AI agent ordered this from my studio." | the real deliverable |
| 0:05–0:11 | KEYFRAME lockup: "Hire a motion designer from chat. Pay only on delivery." | "It paid with one tap, and we could only get paid by handing over the key to the file." | — |
| 0:11–0:21 | Claude.ai: prompt (2× speed) → tool chips (overlay labels if they read `use_plugin`) → quote card; PiP of the watermarked still | "I ask Claude for a launch sting. Keyframe quotes it, shows me the key frame, and gives me an escrow address computed from the deal itself." | quote checks ✓ |
| 0:21–0:31 | PayBox approval window; the card's address and the window's payee slide together and match character by character; passkey/approve | "One approval, no gas, and the money doesn't come to me. Full disclosure: I'm playing both the buyer and the studio." Lower third (3 s): *"Disclosure: buyer and studio wallets are both mine. Real USDC, Base mainnet."* | payee == E |
| 0:31–0:41 | SEALED animation → Basescan page for E: titled "Address" (not "Contract"), no Contract tab, 4 USDC; overlay "No contract here yet. The address IS the deal."; verify ticks | "It's sealed at an address made from the deal. It can only pay the studio if my file's key is published in time. Otherwise it comes back to me." | no code + Transfer log |
| 0:41–0:56 | Status (speed-ramped, chip "+0:52 real time") → Basescan release tx, decoded input `key = 0x4f…`; logs: Released + Transfer E→studio; E now shows "Contract, created by factory"; KEY PUBLISHED animation; plugin ticks; sting plays | "To get paid, the studio publishes the key on-chain. My plugin, not their server, reads that key, decrypts the file and checks it's exactly what I ordered." | key in calldata |
| 0:56–1:09 | Order #2: Countdown, $2, 5-min deadline; status page "Studio: paused (demo)"; real clock speed-ramped; refund tx From = keeper; PayBox balance +2.00; RETURNED | "What if we're late? I paused my own studio. The deadline passes, and the money comes home by itself. I didn't tap anything." Caption "0 taps" | keeper refund |
| 1:09–1:17 | Builder's HyperFrames Studio timeline (keyframes, eases), paper sketches of the envelope mark; Studio-tier card | "Every template is designed by hand; the agent only fills in the blanks. Or skip the templates and hire me directly." | human craft |
| 1:17–1:26 | Diagram x402 → envelope → key / clock; supertitle "MoonPay Commerce gives every payer a deposit address. Keyframe makes it trustless."; end card = credits-as-receipts (E, funding, release, refund txs) + "Unaudited · $50 cap · MIT" | "The escrow is open source, so any x402 seller can offer pay-on-delivery. Keyframe: hire a studio from chat, pay only on delivery." | tx hashes |

**Recording logistics:**

*Sequencing:*
- Unofficial plugins become usable only after **Submit**, by enabling them in PayBox → Plugins. So upload and submit early, then record.
- Record on the final submitted version. If a fix is needed, re-upload and re-submit before the lock, and re-record if the flow changed.

*Account and wallet setup:*
- Grant Claude.ai only the buyer wallet (a plain EOA with no 7702 code; avoid gasless swaps beforehand), holding about $15 USDC.
- The studio wallet stays ungranted.
- Test `iframe` vs `always_approve` and pick the one that shows the payee most clearly.
- Captions say "1 approval" unless a passkey actually appears on screen.

*Capture setup:*
- Clean Chrome profile, 1920×1080 viewport at 110–125% zoom, notifications off, a fresh chat with no custom instructions.
- Basescan tabs pre-tested.
- OBS at 60 fps. If approval happens on the phone, use an iOS screen recording composited as PiP.

*Takes:*
- Happy path and refund are recorded as separate takes. Five rehearsals off camera in the same hour.
- Every take is real. Waits are speed-ramped with a visible real-time counter. Raw takes are kept and linked from the repo.

*Audio:*
- VO recorded after picture lock, one take per line, normalized to −16 LUFS with −1.5 dBTP.
- Music must be builder-made or CC0. MoonPay and Launchpad get a perpetual license to the video, so no licensed tracks.
- No MoonPay or PayBox logos in Keyframe branding (nominative mentions and screen recordings only).

*Edit and post:*
- Edit in a HyperFrames `film/` project, which dogfoods the motion system. Captures go in as muted clips in sub-compositions; follow the builder's notes on PNG frame extraction.
- Export H.264 at 1080p.
- Upload natively to X. The first frame is the sting. Pin the post.

---

## D. Submission copy (character counts computed)

**Project names (≤80):**
1. `Keyframe: hire a motion designer from chat, pay only on delivery` (64) ← recommended
2. `Keyframe: pay-on-delivery motion studio for agents (one-tap x402 escrow)` (72)
3. `Keyframe: the escrow that only opens with the key to your file` (62)

**"What does your project do?" (≤280):**
1. (265) "Hire a motion designer from chat and pay only on delivery. One PayBox tap seals your USDC at an escrow address computed from the deal. The studio is paid only by publishing the key to your file on Base before the deadline; otherwise your USDC comes back, zero taps."
2. (264) "A human-designed motion studio agents can hire: launch stings, portfolio cards, countdowns, ready in minutes. You pay with one gasless tap into an escrow that pays us only if we publish your file's key on time, or else refunds you. Open-source for any x402 seller." ← recommended, because it carries the most `discover_plugins` keywords
3. (268) "Pay-on-delivery for x402, live as a motion studio. Your one-tap USDC lands at an address that IS the deal: it can pay the seller only if they publish the key that decrypts your file before the deadline; otherwise anyone can send it back to you. Nobody can redirect it."

**X post** (both variants are within 280; the handle and hashtag are UNVERIFIED and should be replaced with official ones):
- A (274): "Keyframe: hire a motion designer from chat, pay only on delivery.⏎⏎One @PayBox tap seals your USDC at an address that IS the deal. My studio gets paid only by publishing the key to your file on Base. Miss the deadline and it comes back to you. Zero taps.⏎⏎#MoonPayHackathons"
- B (276): "Hire a motion designer from chat. Pay only on delivery.⏎⏎One @PayBox tap seals USDC at an address that IS the deal. We only get paid by publishing the key to your file on Base. Late? You get it back, zero taps.⏎⏎Solo build for @moonpay Hackathons. Both wallets shown are mine."

**Reply thread:**
1. (236 weighted) The mechanism plus the MIT repo link.
2. (213) "Order from any x402 client, not just PayBox: <llms.txt>; Live counter (sealed / key published / returned): <live>; First 50 commissions at launch prices. Unaudited, $50 cap per order."

---

## E. Traction and go-to-market

1. **Open x402 for every client.**
   - The same backend serves `GET /v1/catalog`, `POST /v1/quotes`, `POST /v1/orders/{quote_id}` (x402 v2 only) and `GET /v1/orders/{id}`.
   - A single-URL form: `GET /v1/orders/new?f=countdown&label=…&target=…&aspect=1:1&style=…&payerAddress=0x…&exp=<unix>&n=<nonce>`. It deliberately mirrors MoonPay Commerce's `?payerAddress=`.
   - Terms are derived deterministically from the canonical URL, with K = HMAC(secret, canonical URL), so the 402 is stateless and byte-stable.
   - The `site/order` page builds these links and shows curl and x402-fetch snippets.
   - Test and list compatibility with PayBox, x402-fetch and the KeeperHub wallet; the KeeperHub wallet can also run the hourly probe.
2. **`/llms.txt` + `/openapi.json`:** what Keyframe is, the 5 order steps, the CREATE2 derivation, the KFC1 spec, guarantees and non-guarantees, content policy, links. Register on x402scan/Bazaar if the mechanics allow (UNVERIFIED). Reaching 10 unique payers is the threshold PayBox's curated `discover_services` uses.
3. **`/live` counter:**
   - Shows sealed (count/USDC), key published, returned, in flight, median Instant delivery time, on-time rate, and unique buyers excluding a disclosed list of builder wallets.
   - Shows the last 20 envelopes with Basescan links.
   - Data comes from factory events plus Transfer logs to quoted E's, cached 60 s. Each state change animates in the motion language.
4. **"First 50 commissions, pay on delivery" thread:** hook + film → mechanism → menu and prices → "any x402 client" snippet → MIT middleware → live counter. Each delivered piece is reposted (with permission) with its receipt end card. The submission reports only non-builder wallets.
5. **Lumara entrants.** Finalists were announced 16 Oct from 700+ entries; awards are 26 Oct in NYC, with a "Rekt Award".
   - Offer festival title cards and stings, pay-on-delivery.
   - Launch a Portfolio Pulse "Rekt" style as a satire/meme hook.
   - Invite motion makers to self-host the MIT package. Keyframe escrows only its own sales.
6. **MoonPay Commerce.**
   - A one-page memo to the Commerce team through the winner GTM advisory: "Delivery-protected paylinks: your per-payer deposit address becomes CREATE2(terms); sweep becomes release-on-key or refund-at-deadline; same `payerAddress` UX."
   - For self-hosted digital-goods x402 sellers (presets, LUTs, fonts, async render or AI jobs): "buyer protection in 20 lines".
7. **README outline (`x402-pod`, MIT):**
   1. What it is.
   2. Guarantees vs non-guarantees.
   3. Quick start (Hono, ~20 lines).
   4. How it works (diagram).
   5. Verified Base addresses.
   6. Security: unaudited, $50 cap, invariants, Halmos, threat model.
   7. Client-side verification (viem snippet).
   8. Keepers (Cloudflare Cron + KeeperHub template).
   9. Compatibility matrix.
   10. FAQ:
       - Why not x402 v2's `escrow` flow? It's synchronous deposit-then-charge inside one request, server-trusted.
       - Why not AuthCaptureEscrow? It needs an operator and 2–3 approvals; use it above the cap.
       - What about quality?
   11. Lineage: HTLC / ZKCP / FairSwap.
   12. License.

---

## F. Meaningful human contribution

**What the builder authors personally:**
- The motion language (`design/MOTION.md`: principles, eases, durations, type, palettes, glyph system, SFX).
- Every template's storyboard, style frames, keyframing and code.
- Watermark tiles, end card, preset palettes, and the Studio-tier pieces.
- The escrow contract, tests and threat model.
- The film (direction, edit, VO) and all copy.

**How it's documented:**
- `HUMAN.md` ledger: artifact → author → tools → AI assistance (yes/no, how) → evidence links.
- `design/<template>/` holds sketches (photos of paper), style frames, motion tests and NOTES.md decisions.
- Three timelapses of template authoring (20×), linked in the README, with a 5 s excerpt in the film.
- Template QA contact sheets signed off by the builder.
- `PRE-EXISTING.md` discloses reused material: the Ripcord brand and fonts (Clash Display/Satoshi under the ITF FFL, Space Mono under the OFL), and any prior motion components. The T&C require disclosure of material pre-existing components.

**Repo licensing:** template source is visible in the repo under CC BY-NC 4.0 (evidence plus reproducibility); plugin, middleware and contracts are MIT.

**Every product surface states the split:** "Designed by hand by <builder>; agents only fill typed fields."

---

## G. Sequence for my areas (L = lock, Sun 01:00 WAT / Sat 20:00 EDT)

| When | Work |
|---|---|
| L-23h → L-20h | Freeze A3/A5 schemas and plugin text templates. `packages/catalog`. Countdown template (fastest) + `probe` SKU. Worker container on the VPS (`doctor`, `browser ensure`, `benchmark`). Day-1 live probes at $0.10 / $8 / $50 through Test console, Validate and Claude.ai. |
| L-20h → L-10h | Launch Sting (2 styles) and Portfolio Pulse (1 style). Still lane + watermark. KFC1 pack/verify. Release and plugin verify E2E. fast-check QA. |
| L-10h → L-7h | Final `pnpm test`; upload; hosted checks; Submit; enable; five rehearsals. |
| L-7h → L-3h | Record takes; Basescan captures; VO. |
| L-3h → L-0.5h | Edit `film/`; export; post on X (assume it's due at the lock; UNVERIFIED); submit copy. |
| After lock | Kinetic Post and Chart Moment; Rekt style; Studio v1.1 factory + review; `/live`, `/order`, `/open`, llms.txt; thread; Lumara and Commerce outreach; warm-page still spike. |

## H. Unverified items and day-1 probes (product, pipeline and demo)

**PayBox and Claude.ai:**
- What the PayBox x402 approval window displays (payTo? description?), and whether a passkey appears in `iframe` mode.
- The plugin proposal amount limit (probe $50) and the paid re-fetch timeout.
- Whether `use_plugin` forwards image content blocks; whether wallet_id is needed for data tools; how Claude.ai labels plugin tool chips.
- The exact field names in `get_portfolio` output (call it day 1).
- Whether auto-undelegate exists for Base.

**HyperFrames:**
- `snapshot` latency on the VPS (target p95 ≤4.5 s); whether `--variables` works for snapshot.
- Whether `--docker` is byte-identical on our templates; VPS render times vs the perf budget.

**External services and pricing:**
- Coinbase/DefiLlama endpoints and rate limits; Arweave/Turbo or IPFS pricing and payment.
- VPS and domain pricing and availability; the MoonPay buy-link minimum; USDC's Base EIP-712 domain ("USD Coin", "2").

**Demo and posting:**
- Basescan labels: there is no literal "Contract: none", so use "Address" + the no-Contract-tab view + `eth_getCode = 0x`.
- Whether `oojae.github.io/ripcord/brand/wordmark.svg` is the live path.
- The X handles (@PayBox, @moonpay), any required hashtag, and the video deadline.
- Remotion license terms (only cited for comparison).

### Critical files for implementation
(planned paths; the workspace is empty)
- /Users/oluwademilade/Desktop/paybox/packages/catalog/src/formats.ts (shared zod schemas, prices, specHash)
- /Users/oluwademilade/Desktop/paybox/plugin/src/plugin.ts (9 tools, frozen descriptions and text templates; built on starter `src/paybox.ts` from https://developer.paybox.sh/plugin-starter/v1.0.2/src/paybox.ts.txt)
- /Users/oluwademilade/Desktop/paybox/templates/launch-sting/index.tmpl.html (+ `template.json`, `design/`)
- /Users/oluwademilade/Desktop/paybox/render-worker/src/job.ts (still lane, render, finish, KFC1 pack, upload)
- /Users/oluwademilade/Desktop/paybox/film/index.html (the X film as a HyperFrames project)

Existing references:
- /Users/oluwademilade/Desktop/ignix/video/hyperframes/HYPERFRAMES_NOTES.md (the builder's measured render timings and gotchas)
- /Users/oluwademilade/Desktop/Ripcord/docs/brand/BRAND.md and /Users/oluwademilade/Desktop/Ripcord/web/src/styles/tokens.css (Ripcord brand for the cold-open order)
