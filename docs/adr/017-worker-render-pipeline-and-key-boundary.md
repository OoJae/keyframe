# ADR-017: Render worker pipeline, and the worker's key boundary

- Status: accepted (engineering). The key boundary needs the builder's sign-off, see "Open question".
- Date: 2026-10-17
- Area: `apps/worker`
- Numbering: 001–015 are reserved for the topics in `docs/design/verification.md`, and 016 is the protocol package.

## Context

Instant orders are render-before-pay (verification.md §9, delta 2). A quote turns `final` only after its key-frame
still, its 540p watermarked preview and its KFC1-encrypted master exist, because `T.contentHash` is the master's
`manifestHash`. Someone has to turn the quote's typed params into those artifacts on a box with Chrome and ffmpeg.
That box is a VPS, or the builder's Mac through a tunnel, and both are a larger attack surface than the API. The
design documents disagree on who encrypts:

- product-render-demo B5: the worker packs with a key file;
- architecture e.5: the API encrypts;
- frozen-interfaces §4: "KMASTER lives only in the API environment. The render worker never holds keys."

The API (`apps/api/src/internal/jobs.ts`, built concurrently) settled it in code. Each job carries **K_file** for
that one file, and nothing else.

## Decision

1. **Pull, never push.** The worker polls `POST /internal/jobs/claim` over HTTPS with the bearer `WORKER_TOKEN` and
   `X-Worker-Id`. It needs no inbound port, so it can run behind NAT or a tunnel. Each claim gets one try, because the
   API's claim is not idempotent and a lost response would strand a job under this worker's 600 s lease. Lease
   renewal is `POST {upload.heartbeat} {progress}`, and a 409/403 means the job is gone, so the worker aborts and
   cleans up.
2. **One job, every artifact, in the order the quote needs them.** stamp → `snapshot --at heroTime` → watermark
   composite → PUT still (the quote can show its key frame while the master renders) → `hyperframes render
   --variables-file --strict-variables --strict --no-best-effort` → `ffmpeg -c copy -movflags +faststart` →
   ffprobe assertion (codec, pix_fmt, exact size and fps, duration ±1 frame, frame count) → `parseMp4Header` on the
   first 1,048,560 bytes (exactly the chunk the plugin will decrypt first) → 540p watermarked preview → PUT preview
   → KFC1 seal → PUT manifest, then each chunk → `done {template, renderer, keyframe_at_ms}`.
3. **Key boundary: the worker receives K_file and nothing above it.** KMASTER, K_chain and K_buyer never leave the
   API. K_file = HKDF(K_chain ‖ K_buyer, T.salt, "keyframe/kfc1/file") is one-way, so K_file does not yield K_chain
   (keyHash commits to K_chain, and `release` is seller/operator-only anyway). It opens exactly the file this
   worker just rendered, whose plaintext the worker already holds. The worker logs neither K_file nor the token
   (tested), never writes K_file to disk, and child processes get an allowlisted environment.
4. **Seal with the protocol's code.** `encryptKfc1` takes K_chain/K_buyer, which the worker must not have, so only the
   per-chunk AES-GCM step is local (`src/kfc1.ts`). The manifest goes through `ManifestSchema`, `jcs` and `sha256Hex`,
   and every chunk is decrypted again with the protocol's `decryptKfc1Chunk` before upload. A unit test proves the
   output is byte-identical to `encryptKfc1` at 1, 2 and 3 chunks, and that the plugin's
   `deriveFileKey(K_chain, K_buyer, salt)` decrypts it. The API still re-decrypts every chunk with its own key and
   self-verifies from storage before `final`.
5. **Retries.** HTTP calls retry at most 3 tries on network errors, 408/425/429 and 5xx, and never on other 4xx. Job
   retries belong to the API (`max_attempts`, 3 for renders). The worker reports `retryable` truthfully: timeouts,
   Chrome or ffmpeg crashes and upload outages are retryable; a bad template, bad variables, a spec mismatch or a
   4xx upload rejection are not. Hard per-job timeout is the still budget plus max(`RENDER_TIMEOUT_MS`, perf budget
   × 4) plus ffmpeg and upload allowances. Job directories are always removed.
6. **Deterministic by default.** `BROWSER_GPU=off` (SwiftShader) for snapshot and render. Two full runs of countdown
   and probe at all three aspects gave 24/24 byte-identical artifacts (master, preview, still, raw still) at the same
   speed as the hardware GPU. With the hardware GPU, a 16:9 master differed between runs (58 dB PSNR, invisible), which
   matches the builder's own HyperFrames notes. The hero frame of the master is composited like the still and compared
   by SSIM (≥ 0.97, logged; measured 0.99889–0.99998).
7. **Never** `hyperframes feedback|publish|cloud|lambda|cloudrun|auth`. Telemetry, update checks, skills and
   runtime auto-installs are off in every child (`HYPERFRAMES_NO_TELEMETRY`, `HYPERFRAMES_NO_UPDATE_CHECK`,
   `HYPERFRAMES_SKIP_SKILLS`, `HYPERFRAMES_NO_AUTO_INSTALL`, `DO_NOT_TRACK`), and `snapshot --describe false`.

## Consequences

- Delivery needs no master upload to private storage, and the API never holds plaintext video. The API's
  per-chunk check plus its self-verify catch a buggy or hostile worker before any quote can be paid.
- A compromised worker can leak the plaintext of files it renders, or upload a wrong-but-valid video. It cannot
  move funds or open other orders. The quality gap is disclosed product-side, and the still the buyer approved is
  committed in the spec.
- Worker-side `toTemplateVars` (`src/vars.ts`): the API sends raw spec params, so formatting (UTC target text,
  remaining seconds, palette presets from `templates/_kit/palettes.json`) happens in the worker, next to the
  templates it serves.

## Open question (for the builder)

The literal frozen §4 sentence says the worker "never holds keys". This ADR reads it as never holding KMASTER,
K_chain or K_buyer. That is the reading the API implements, and it is the only one under which the worker can seal
what it renders. If the stricter reading is wanted, the change is in the API: it would accept a plaintext master
upload, seal it itself, and stop sending `kfc1.k_file`. On the worker side, `sealFile` would be replaced by an
upload of the master. No frozen surface (manifest, hashes, storage layout) changes either way.
