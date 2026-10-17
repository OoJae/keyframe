# ADR-015: Render-before-pay for Instant quotes (API side)

- Status: accepted (engineering), for the builder's review. The worker side is ADR-017.
- Date: 2026-10-17
- Area: `apps/api` (`src/quotes/*`, `src/internal/jobs.ts`, `src/delivery/*`)
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

Frozen §1 says that for Instant orders `T.contentHash = manifestHash`, so the escrow address commits to the exact
encrypted file the buyer previewed, and the key can be released seconds after funding. The manifest only exists
after rendering. So the quote cannot be payable when it is created.

## Decision

- `POST /v1/quotes` creates a **draft**. Its provisional T has `contentHash = 0` and `keyframe = null`, and a
  render job is queued in the same D1 batch. The draft is a valid §7 quote object (`retry_after_ms > 0`), and
  `ALL /v1/orders/{id}` answers **425** without a 402.
- The worker receives `K_file` (HKDF of `K_chain ‖ K_buyer` with `T.salt`) for its one job, never `K_chain`,
  `K_buyer` or `KMASTER`. It uploads the still, the watermarked preview, the manifest and the chunks.
- The API trusts none of it:
  - each chunk is re-hashed and decrypted with the protocol's own KFC1 code;
  - chunk 0 must parse as a faststart MP4 with the spec's resolution and duration;
  - on `done`, the whole file is re-read from public storage, decrypted and checked against `plaintextSha256`.
- On `done` the quote becomes **final**:
  - the spec gains `keyframe {stillSha256, atMs}` and the template and renderer that actually rendered it;
  - T gets `contentHash = manifestHash`;
  - `termsHash` and E are recomputed;
  - the payment window (`QUOTE_TTL_S`) starts now, and the chosen delivery window (deadline − expiry) is kept.
- Three failed render attempts, or a draft older than `DRAFT_TTL_S`, cancel the quote. No money is involved.
- Stills and previews are stored per attempt (`s/{quote}-{tag}`), so a re-render never reuses an immutable URL.
- Only formats whose template is designed are sold. `src/templates.ts` bundles `templates/<id>/template.json` at
  build time and takes styles, durations, hero frames and readiness from it, so the API never queues a render the
  worker would refuse.
- Studio quotes are final immediately, with `contentHash = 0` and a review window. They bind at `deliver(T, manifestHash)`.

## Consequences

- Paying an Instant order funds E, and the next call releases `(T, K_chain, T.amount, manifestHash)`. Delivery is
  seconds after payment, and the plugin can verify the file before the user pays.
- Nonces are counters (KFC1). One quote encrypts exactly one plaintext. A changed render needs a new attempt and a new
  manifest, and a final quote's file never changes.
