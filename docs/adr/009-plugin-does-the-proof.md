# ADR-009: The plugin does the proof (independent RPCs, pinned allowlists, no getLogs)

- Status: proposed (drafted for the builder's review)
- Date: 2026-10-17
- Area: `plugin/` (`src/core/quote.ts`, `probe.ts`, `deal.ts`, `resolve.ts`, `onchain.ts`, `delivery.ts`, `typed.ts`, `siwe.ts`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

The plugin bundle is frozen at upload, while the backend keeps changing afterwards and may be buggy or
compromised. PayBox's approval window shows raw transaction details only, with no decoded token summary, and
PayBox treats tool descriptions as untrusted labels. So the only party that can tell the user "this payment pays
exactly the deal you saw" is code that is frozen together with the deal format: the plugin.

## Decision

1. **Recompute, never trust.** Every money-relevant value comes from Terms through the vendored, frozen protocol
   code (`plugin/src/protocol`). That covers `termsHash`, `VAULT_IMPL` (factory nonce 1), the clone init-code hash
   and escrow `E`, plus `salt = keccak256(quote_id)` and `specHash = sha256(JCS(spec))`. The plugin compares each
   one with what the API claims. Any mismatch is a `fail`, and a `fail` means no proposal.
   **The payment is bound to the reviewed deal.** The API serves the quote again when the payment tools run, so
   `keyframe_commission` and `keyframe_commission_direct` take `buyer` and `terms_hash` (required) from
   `keyframe_quote`'s (or `keyframe_status`'s) `next.input`. They refuse unless the re-fetched Terms hash locally to
   that `terms_hash` (`same_deal`) and `T.buyer` is that wallet (`buyer_matches`), so a backend cannot swap the
   refund wallet or raise the price or deadline between review and payment. `keyframe_status` takes an optional
   `buyer` for the same check.
   **Payment-only bounds** (the factory's caps): `T.reviewWindow` ≤ 14 days and `T.killFeeBps` ≤ 5000
   (`deal_bounds`). Refunds do not apply them, so an older factory's deals stay refundable.
2. **Pinned allowlists from env.** `KEYFRAME_FACTORIES` (each with `status` and a `vaultImpl` that must equal
   nonce 1), `KEYFRAME_SELLERS`, `KEYFRAME_OPERATORS` and `KEYFRAME_MAX_AMOUNT` (clamped to 50 USDC). The defaults
   are empty, and an unparsable value counts as empty, so the plugin fails closed until the portal names the
   deployed contracts.
3. **Live 402 pre-fetch** (frozen §8). The plugin sends the same request PayBox's probe sends (POST, no body). It
   then requires a single wire version and exactly one requirement in total (`accepts.length == 1`; an extra
   option beside the right one is refused, since PayBox, not the plugin, picks what to sign), which must be
   `exact` / `eip155:8453` / Base USDC with `payTo == E` and `amount == T.amount`. 409 and 410 map to "already
   paid" and "expired". This check is a snapshot: PayBox fetches the 402 again at approval time, so wherever the
   user compares the payee the plugin prints the **full** escrow address in groups of four
   (`0x4B22 f48f B87B …`), and it names the direct rail, whose calldata fixes the payee (ADR-011).
4. **The escrow must be unused.** If any configured RPC sees the deal already registered, or the escrow already
   holding at least the price, payment is blocked. Paying twice is never what the user wants.
5. **Render-before-pay is checked, not assumed.** For a final Instant quote the plugin checks four things: the
   committed key-frame still (it fetches it and hashes it), that `contentHash == content.manifest_hash ≠ 0`, that
   the committed manifest is already public (`file_available`), and that its resolution is the brief's aspect.
6. **Independent RPCs, cross-checked.** Every read goes as one JSON-RPC batch to each of `KEYFRAME_RPC_URLS` (2 by
   default) in parallel. `verified` requires at least 2 agreeing answers. A disagreement or a single answer gives
   `partial`, never a pass. RPC URLs are never echoed. **No `eth_getLogs`:** state comes from the factory's storage
   view `order(termsHash)`. Funding is proven from the receipt's USDC `Transfer` log when a tx hash is known; that
   receipt counts only when at least 2 RPCs return the same one (else `funding_tx` is `skip`), and extra reads
   (the receipt, a sweep token's balance) count toward the snapshot's `consistent` flag.
7. **Delivery is decrypted here.** The plugin reads `K = order(h).key` and checks `keccak256(K) == keyHash`. For
   Instant it also checks `manifestHash == contentHash`. Then it fetches the manifest and checks its hash, checks
   each chunk's ciphertext hash, decrypts it with WebCrypto, checks its plaintext hash, checks the whole-file
   fingerprint, and reads the MP4 header (`moov` in chunk 0) against the manifest and the brief. Chunks are sampled
   adaptively (first, last, then the rest) within the budget. A truncated or unverifiable result is `skip`, never
   `pass`. If the file host fails, the plugin falls back to the optional IPFS mirror (see ADR-010). Locations never
   count; only hashes do. The brief (spec) from the API is used for `matches_brief` and private-delivery checks only
   if `sha256(JCS(spec)) == T.specHash`; otherwise there is no trusted brief, `matches_brief` is `skip` and the
   verdict is at best `partial`.
8. **Nothing dangerous to sign.** The plugin cannot sign; it only hands the agent messages for core
   `request_wallet_sign`. Accept/reject typed data from the API must use the `Keyframe Escrow` / `1` / 8453 domain
   of this order's allowlisted factory, and a Decision must have exactly the frozen type and message fields, the
   requested `accept`, this order's `termsHash`, and a deadline within 7 days. It is validated exactly as received:
   if the sanitizer would change anything (trailing spaces, zero-width or control characters) it is refused, as is
   any type name that normalizes to `Decision` or `EIP712Domain` without being it. The plugin returns its own
   canonical payload, not the backend's object, with a deadline of at most 7 days and never past what the phase
   allows: the on-chain review end, or, after a change request, the order view's `changes.accept_by` clamped to the
   on-chain review end + 3-day grace (ADR-019: Keyframe then verifies the signed accept off-chain and its operator
   releases; a reject is answered with a full-refund cancel). For **changes** the plugin never uses backend typed
   data: it builds `ChangeRequest(bytes32 termsHash,uint256 deadline)` itself under the same domain, with a
   deadline of min(now + 1 h, review end). A SIWE message must sign in to the API host only, for the given address, on Base,
   line-exact, and live at most 15 minutes. Before relaying anything (changes included), the plugin recovers the
   signer locally and requires it to be the buyer.
9. **Refund-family proposals.** `refund(T)`, `sweep(T, token)` and `decide(T, false)` can only move funds to
   `T.buyer` (§3, I1/I8). Before proposing one, the plugin requires an allowlisted factory (`active` or
   `refund-only`), re-derives `E` from `T`, and checks on Base that the action is allowed right now, on at least 2
   agreeing RPCs (one RPC alone never decides), and that a registered deal's on-chain record names `T.buyer` and
   `T.deadline` (the API's order_id → terms mapping is not trusted on its own). If it is not allowed yet, the
   refusal gives the exact time it will be. The payment-only checks of §8 (live 402, seller/operator allowlist,
   cap) do not apply here: a paid order's 402 is a 409, and a refund must still work after a seller rotation.
10. **Payment outcomes are read, not guessed** (ADR-019). A paid response may be a full body, a later replay with
    `access_token`/`k_buyer` null (`secrets_withheld`: the plugin points to `keyframe_orders`), 503
    `settlement_recording_delayed` (`charged: true`, resolved through the quote), `charged: "unknown"` (still
    settling: "do not pay again; poll `keyframe_status`", and `funded` is `skip`, never `fail`), a refusal
    (`charged: false`: no money moved) or a 429 (`processed: false`: not processed, not a failure). A `final`
    quote with `payable: false`, or a live 402 answering `charged: "unknown"`, is not payable. A 429 anywhere is
    reported as "rate limited, retry after N s", never with a payment suggestion.
11. **Bounded and quiet.** Each tool gets an 8.5 s budget. Each request gets `AbortSignal.timeout ≤ 4 s`,
    `redirect: "error"` and a byte cap. Backend strings are stripped of control and bidi characters,
    length-capped, and printed as JSON string literals (an embedded quote cannot close them), including in
    refusals; preview links are shown only when they are plain URLs on Keyframe's own file or API host. Echoed
    backend records keep only safe-integer numbers and are capped at 32 KiB each (else dropped), and a whole data
    result at 200 KiB, under the sandbox's 256 KiB stdout line. Errors never include URLs or env values.

## Consequences

- A compromised API can fail an order, but it cannot get a **proposal** that pays anyone other than the escrow
  derived from the terms the user reviewed (same `terms_hash`, same buyer wallet). For x402 that proposal names
  the order URL and the amount cap only: PayBox fetches the live 402 itself at approval time, and that fetch could
  still differ from the plugin's pre-fetch, so the user must compare the full payee address in PayBox's window with
  the one the plugin printed (the direct rail fixes the payee in the calldata instead). A compromised API also
  cannot get a signature usable outside Keyframe's own escrow contract, nor turn a change request into a Decision.
  Adversarial suites in `plugin/test/adversarial.test.ts`, `signing.test.ts` and `audit.test.ts` (the independent
  review's proofs of concept, as regressions) encode this: each hostile backend gets `isError` and no proposal.
- The extra requests (402, still, manifest, 2 RPC batches) all run in parallel after the quote fetch, inside the
  budget. `plugin/test/budget.test.ts` hangs every host for 6 s, and every tool still answers within 8.5 s.
- The proof works without the API at all, from Terms alone (`keyframe_verify` with `terms` + `factory`).
  `plugin/test/anvil.test.ts` runs it against the real `KeyframeEscrowFactory` bytecode on anvil: the derivation
  equals the contract's, the refund, sweep and reject proposals execute and pay the buyer, `decideBySig` accepts the
  plugin's canonical Decision, and delivery decrypts a file with the key the contract published.
- The interpretation in item 9 is the only reading of "Plugin checks before ANY proposal" (§8) that lets a buyer
  refund a paid order. It is recorded here, so the backend can rely on it.
