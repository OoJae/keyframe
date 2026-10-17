# @keyframe/worker: the render worker

Claims `instant_render` jobs from the Keyframe API and turns a quote's typed params into the artifacts the API needs
before a quote can turn `final` (render-before-pay):

1. a watermarked 540p key-frame **still** at the template's hero time (`hyperframes snapshot`);
2. the **master** (`hyperframes render`, `ffmpeg -c copy -movflags +faststart`, ffprobe and MP4-header assertions);
3. a watermarked 540p **preview**;
4. the master **sealed as KFC1** (frozen-interfaces §5) with the job's per-file key, uploaded as manifest + chunks.

It holds **no long-lived keys**: no KMASTER, no K_chain, no K_buyer. Each job carries only K_file for that one file
(ADR-017, which flags this reading of frozen §4 for the builder). Templates live in `../../templates`
(ADR-018). Standalone Node 24 project, kept out of the root pnpm workspace so HyperFrames' heavy dependency tree stays
isolated. It uses npm with its own `package-lock.json`, the same setup as the builder's ignix HyperFrames project.

## Quick start (local, no API)

```sh
export PATH=/Users/oluwademilade/Desktop/paybox/.tools/node-v24.21.0-darwin-arm64/bin:$PATH   # Node 24.21.0
cd apps/worker
npm ci                                   # exact tree from package-lock.json; lifecycle scripts are off (.npmrc)
node node_modules/hyperframes/bin/hyperframes.mjs browser ensure   # pinned chrome-headless-shell 152.0.7977.30
node src/cli.ts preflight                # node, ffmpeg encoders, browser, every template + hash

# Render without the API: still, master, preview, report.json; --seal adds a KFC1 encrypt→decrypt round trip
node src/cli.ts render --template countdown --vars vars.json --out out/          # all aspects by default
node src/cli.ts render --template probe --aspect 9:16 --out out/ --seal

node src/cli.ts check --all --extremes   # strict `hyperframes check`, every template × aspect, defaults + worst case
node src/cli.ts stamp --template countdown --aspect 1:1 --out /tmp/cd   # then: npx hyperframes preview /tmp/cd --no-open
node src/cli.ts templates                # ids, versions, statuses, template hashes (spec.template.hash)
```

`--vars` takes the template's variables (see each `templates/<id>/template.json`). Missing keys take the template's
defaults in the CLI only, since API jobs must be complete. Output per aspect (`out/9x16/` …): `still.png`
(watermarked, served as the quote preview), `still.raw.png`, `master.mp4`, `preview.mp4`, `report.json` (timings,
ffprobe, MP4 header, hero-frame SSIM, sha256s) and with `--seal` `kfc1/c/<manifestHash>/{manifest.json,0.bin,…}`.

Every hyperframes child runs with `HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_SKIP_SKILLS=1
HYPERFRAMES_NO_AUTO_INSTALL=1 DO_NOT_TRACK=1`, and `snapshot` always gets `--describe false`. The worker never
invokes `feedback`, `publish`, `cloud`, `lambda`, `cloudrun` or `auth`.

## Tests

```sh
npm run typecheck          # tsc (src + tests), erasable TS only: Node runs src/*.ts directly
npm test                   # 63 unit tests, about 2 s, no browser needed
npm run test:integration   # 8 tests: real renders against a fake API that validates like the real one (about 40 s)
npm run sync:protocol:check   # src/protocol is byte-identical to packages/protocol/src (also a unit test)
```

`src/protocol/` is vendored with `node ../../scripts/sync-protocol.mjs --target src/protocol`. Don't edit it.
`src/register.ts` maps the protocol's NodeNext `./x.js` specifiers to `./x.ts` for Node's type stripping.

## Service mode

```sh
cp .env.example .env    # set API_BASE and WORKER_TOKEN (the API's WORKER_TOKEN secret, ≥ 32 chars)
node --env-file=.env src/cli.ts serve
```

The worker only makes **outbound** HTTPS calls to `API_BASE`, so it needs no inbound port. `GET /healthz` (status,
lanes, counters, last API contact) and `GET /readyz` (200 when it can take work) are served on `HEALTH_HOST:HEALTH_PORT`
(default `127.0.0.1:8790`). SIGTERM/SIGINT stop claiming, let jobs finish for up to `DRAIN_TIMEOUT_MS`, then report
the rest as retryable failures.

### Internal API used (apps/api/src/internal/jobs.ts, mounted at `/internal`)

Every call sends `Authorization: Bearer $WORKER_TOKEN` and `X-Worker-Id`, and only to `API_BASE`'s origin
(job-supplied paths must be `/internal/jobs/...`).

| Step | Call | Worker behaviour |
|---|---|---|
| claim | `POST /internal/jobs/claim {worker_id, kinds:["instant_render"]}` → 200 job inputs \| 204 | One try per poll, every `POLL_INTERVAL_MS`, while a lane is free. Inputs are validated with zod (`src/jobs.ts`); invalid → `failed` (not retryable). |
| lease | `POST {upload.heartbeat} {progress}` every `HEARTBEAT_INTERVAL_MS` | 409/403/404 → the job is no longer ours: abort, clean up, no report. |
| still | `PUT {upload.still}` `image/png` | Right after the snapshot, before the master renders. |
| preview | `PUT {upload.preview}` `video/mp4` | |
| manifest | `PUT {upload.manifest}` KFC1 manifest JSON | A 409 with the same manifest hash (an earlier try landed) counts as success. |
| chunks | `PUT {upload.chunk with {i}}` ciphertext chunk i | |
| done | `POST {upload.done} {template:{id,version,hash}, renderer, keyframe_at_ms}` | `template.id` is echoed as the API sent it. Version and hash are this worker's (the API puts them in the spec). |
| failure | `POST {upload.failed} {error:"<code>: <message>", retryable}` | See below. The API applies `max_attempts` and cancels the quote when attempts run out. |

Failure codes: `bad_job`, `bad_template` (unknown, awaiting design, unsupported aspect/duration/style),
`bad_variables`, `spec_mismatch` and `upload_rejected` (4xx) are **not retryable**. `timeout`, `render_failed`
(Chrome/ffmpeg exit), `upload_failed` (network/5xx after 3 tries), `shutdown` and `internal` are **retryable**.

### params → template variables

The API sends the spec's raw `params`, so `src/vars.ts` is `toTemplateVars`: per-template mappers (countdown: label,
UTC `target_text`, `remaining_s` from the job's start time, cta, palette; probe: `values.probe_id` or the quote id),
followed by the template's own validation. Palette presets resolve through `templates/_kit/palettes.json`. All five
are `null` until the builder designs them, and a `null` preset means the template's default colours. A template
without a mapper cannot be rendered from a job.

## Deploy

### Railway (production since 2026-10-17)

The same image runs 24/7 on Railway: project `keyframe-worker`, service `render-worker`. It is built from this
Dockerfile with the repository root as context; the root `.railwayignore` limits the upload to `apps/worker` and
`templates`, and never includes `.env` or `node_modules`. The service always restarts, is capped at 4 vCPU and
4 GB, and has no public port, because the worker only calls the API outbound. Variables: `API_BASE`, `WORKER_ID=render-railway-1`,
`BROWSER_GPU=off`, `POLL_INTERVAL_MS=3000`, `RENDER_LANES=1`, `RENDER_WORKERS=3`, `HEALTH_HOST=0.0.0.0`, and the secret
`WORKER_TOKEN`, which is set with the CLI and never printed. Redeploy from the repository root with `railway up --service render-worker`.

### VPS (primary): Docker, linux/amd64

```sh
# from the repository root (the image needs templates/)
docker build --platform linux/amd64 -f apps/worker/Dockerfile -t keyframe-worker .
docker run -d --name keyframe-worker --restart unless-stopped \
  --platform linux/amd64 --shm-size=2g \
  --env-file apps/worker/.env \
  -v keyframe-work:/work \
  -p 127.0.0.1:8790:8790 \
  --read-only --tmpfs /tmp:rw,size=2g \
  --cap-drop ALL --security-opt no-new-privileges \
  keyframe-worker
docker logs -f keyframe-worker          # pino JSON; never contains the token, K_file or presigned queries
curl -s 127.0.0.1:8790/healthz | jq .
```

The image is `node:24.21.0-bookworm-slim` (pinned by digest) plus Debian's ffmpeg, Chrome's shared libraries and
`tini` as PID 1. It installs the exact npm tree with no lifecycle scripts, then runs `hyperframes browser ensure`,
which downloads the pinned `chrome-headless-shell 152.0.7977.30` into the `node` user's cache. It runs as `node`.
`preflight` is a build gate, and `HEALTHCHECK` polls `/healthz`. amd64 only: chrome-for-testing has no linux-arm64
headless shell (the Dockerfile refuses other platforms). The VPS needs 4 vCPU / 8 GB (B7). Each render worker is a
Chrome of about 256 MB, and `RENDER_WORKERS=3` by default.

Verified in this image (built on Apple silicon with `--platform linux/amd64`, so emulated): `preflight` passes at
build time, the 6 service integration tests pass inside the container (`docker run … -v $(pwd)/test:/app/apps/worker/test:ro
--entrypoint node keyframe-worker --import ./src/register.ts --test test/integration/service.test.ts`), and a
countdown 9:16 render with `--seal` matches the Mac's still at SSIM 0.996, with hero SSIM 0.99999 and a KFC1
round trip. `serve` with exactly the flags above, read-only root included, reaches `ready`, Docker reports
`healthy`, and `docker stop` drains and exits 0. Timings under emulation (countdown 9:16 render 22.8 s) say nothing
about a real amd64 VPS. Benchmark there with `node src/cli.ts render --template countdown --out /work/bench`
inside the container (B2 budget: 6 s at 1080×1920 in ≤ 45 s).

### Builder's Mac (secondary): native, optionally behind cloudflared

The worker pulls jobs, so the Mac needs **no tunnel to work**. It only calls the API outbound, exactly like the VPS.
Run it natively, not in Docker, because Docker on Apple silicon would need an emulated amd64 Chrome:

```sh
cd apps/worker && npm ci
node node_modules/hyperframes/bin/hyperframes.mjs browser ensure   # already cached on this Mac
cp .env.example .env && $EDITOR .env      # API_BASE, WORKER_TOKEN, WORKER_ID=builder-mac
caffeinate -i node --env-file=.env src/cli.ts serve
```

To let monitoring (or the API's capacity view) see the Mac's health endpoint, publish just that port through a
Cloudflare Tunnel, protected by Cloudflare Access (service token). Never expose it unauthenticated:

```sh
cloudflared tunnel login
cloudflared tunnel create keyframe-mac
cloudflared tunnel route dns keyframe-mac render2.<your-domain>
cloudflared tunnel run --url http://127.0.0.1:8790 keyframe-mac
```

If the API is the one running on the Mac (local development), point `API_BASE=http://127.0.0.1:<port>`. Plain http is
accepted only for loopback hosts.

## Verified on 2026-10-17 (builder's Mac: Apple M5, 10 cores; shared with other jobs, load average 6–14)

`node src/cli.ts render --template countdown --vars vars.json --out … --seal` and `--template probe`, with the default
`BROWSER_GPU=off`, run twice. All 24 artifacts (master, preview, still, raw still × 2 templates × 3 aspects) were
**byte-identical** across the two runs.

| Template / aspect | Still (snapshot + watermark) | `hyperframes render` | Master stage* | Total |
|---|---|---|---|---|
| countdown 9:16 | 2.68 s (2.56 + 0.12) | 6.04 s | 7.59 s | 10.3 s |
| countdown 1:1 | 2.51 s (2.44 + 0.08) | 5.55 s | 6.72 s | 9.2 s |
| countdown 16:9 | 2.55 s (2.45 + 0.10) | 5.85 s | 7.34 s | 9.9 s |
| probe 9:16 | 2.56 s (2.47 + 0.09) | 2.66 s | 3.43 s | 6.0 s |
| probe 1:1 | 2.54 s (2.46 + 0.08) | 2.48 s | 3.06 s | 5.6 s |
| probe 16:9 | 2.55 s (2.45 + 0.10) | 2.70 s | 3.39 s | 5.9 s |

\* render + remux + ffprobe/MP4-header checks + 540p preview + hero SSIM. KFC1 seal + decrypt is 1–5 ms (one 1 MiB chunk).

ffprobe on every master: `h264 / High / yuv420p`, exactly 1080×1920, 1080×1080 or 1920×1080, `r_frame_rate 30/1`,
240 frames and 8.000000 s (countdown) or 60 frames and 2.000000 s (probe), no audio stream, 61–216 kB. The MP4 header
read from KFC1 chunk 0 matches (`durationMs` 8000/2000, timescale 1000). Hero-frame SSIM of the master against the
approved still: 0.99889–0.99998. KFC1: `roundTrip=true`, `manifestVerified=true`, and the decrypted sha256 equals the
plaintext sha256 for all six. The decryption goes through the plugin's own path, `deriveFileKey(K_chain, K_buyer,
salt)` + `decryptKfc1Chunk`.

## Determinism

- Templates follow HyperFrames' determinism rules: no clocks, randomness or network. Text never changes through GSAP;
  digits are pre-rendered states toggled by opacity.
- `BROWSER_GPU=off` (SwiftShader, the default) gives byte-identical masters, previews and stills on a given host. With the
  hardware GPU (`auto`/`on`), a re-rendered 16:9 master differed (PSNR 58 dB, 11/240 frames bit-identical) at the
  same speed, which matches the builder's HyperFrames notes §5.
- Across hosts (Mac vs Docker/Linux), stills and masters are close but not byte-identical (different Chrome builds
  and rasterisers). That is fine, because every quote's still and master come from the same job on the same host,
  and the spec commits to the bytes actually produced.

## Security notes

- The token is held in one private field. It is never logged or put in an error message, and it is never passed
  to a child process: children get an allowlisted environment (`src/proc.ts`, tested). It is only sent to
  `API_BASE`'s origin.
- K_file lives only in memory for the job's duration. It is never logged (tested) or written to disk.
- Every child process (hyperframes → Chrome, ffmpeg) runs in its own process group, killed on timeout, abort or exit.
- Job directories contain buyer inputs and are deleted after every job (`KEEP_JOBS=1` is for debugging only).

## Layout

```
src/cli.ts          entry (registers the .js→.ts hook, then main.ts)    src/main.ts       commands
src/service.ts      claim loop, lanes, lease, job lifecycle             src/api.ts        internal API client
src/pipeline.ts     still / master stages                               src/kfc1.ts       KFC1 seal with K_file
src/stamp.ts        per-job composition from index.tmpl.html            src/templates.ts  template.json schema, hash
src/vars.ts         params → template variables                         src/watermark.ts  watermark tiles
src/hyperframes.ts  pinned CLI wrappers   src/ffmpeg.ts  remux, ffprobe assertion, preview, SSIM   src/proc.ts  processes
src/seal.ts         local --seal round trip   src/http.ts  bounded retries   src/health.ts  /healthz /readyz
src/protocol/       vendored @keyframe/protocol (generated)
```
