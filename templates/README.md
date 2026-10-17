# Keyframe templates

HyperFrames compositions the render worker (`apps/worker`) stamps per job and renders. **The templates are the
builder's human craft.** Engineering ships the system, two deliberately plain reference templates and the variable
schemas. The designs are the builder's to make.

| Directory | Status | What it is |
|---|---|---|
| `_kit/` | kit | Shared inputs mounted at `kit/` in every job: `MOTION.md` (skeleton, TODO(builder)), `styles/tokens.css` (neutral reference tokens), `vendor/` (GSAP 3.15.0, byte-identical to the builder's copies), `fonts/` (one neutral OFL placeholder face), `palettes.json` (the five quote palette presets, all `null` until designed). |
| `_watermark/` | kit | The preview watermark tile (REFERENCE). |
| `countdown/` | reference | **REFERENCE IMPLEMENTATION**, 8 s, renders at 9:16, 1:1 and 16:9. |
| `probe/` | reference | **REFERENCE IMPLEMENTATION**, 2 s test card (hidden `probe` SKU). |
| `launch_sting/`, `portfolio_pulse/`, `kinetic_post/`, `chart_moment/` | awaiting-design | `template.json` variable schemas only. |

`template.schema.json` is generated from the worker's zod schema (`node apps/worker/src/cli.ts schema --write`),
and the worker's tests fail if it drifts.

## template.json

| Field | Meaning |
|---|---|
| `id` | Directory name, and `spec.template.id`. `_` prefix = kit-internal. |
| `version` | semver, and `spec.template.version`. Bump on any change. |
| `format` | Spec format it is sold under (frozen-interfaces §6). Hidden SKUs use `catalog`. |
| `status` | `production` · `reference` · `awaiting-design` (schema only, never rendered) · `kit`. |
| `styles` | Allowed `spec.style` values. `styles/<style>.css` is linked through the `KF_STYLE` token. |
| `aspects` | Subset of `9:16` 1080×1920, `1:1` 1080×1080, `16:9` 1920×1080 (sizes are fixed by product-render-demo A2 and checked). |
| `fps` | Output frame rate (30). |
| `durations` | Allowed whole-second durations. One is stamped into the root `data-duration` per job. |
| `heroTime` | Per duration: the second of the quote-time still. It must be a whole frame and inside the clip. `null` is allowed only while awaiting design. |
| `perf` | `renderBudgetS` (longest duration, 9:16, on the 4 vCPU VPS; the job times out at 4× this or `RENDER_TIMEOUT_MS`, whichever is larger) and `stillBudgetS`. |
| `variables` | HyperFrames variable declarations plus validation: `string` (`maxLength` required, `minLength`, `pattern`, `json`), `number` (`min`, `max`, `integer`), `color` (`#rrggbb`), `boolean`, `enum` (`options`). Every `default` must be valid. Strings may not contain control characters. |

Validation is twofold. The worker validates every job's values against these declarations with zod (unknown keys,
types, lengths, ranges, patterns and enums are all errors). Then the render runs with `--variables-file
--strict-variables`, so HyperFrames checks them again.

## Stamping contract (`index.tmpl.html`)

HyperFrames reads the root `data-duration`/`data-width`/`data-height` once at compile time, and `snapshot` takes no
variables. So for each job the worker copies the template bundle into a job directory and writes `index.html`
from `index.tmpl.html` by replacing these tokens, each written in double braces (`{{KF_WIDTH}}`). Any other
`{{...}}` in the template, comments included, is an error:

| Token | Value |
|---|---|
| `KF_WIDTH`, `KF_HEIGHT` (required) | Pixel size of the aspect. |
| `KF_DURATION` (required) | Duration in whole seconds. |
| `KF_VARIABLES` (required) | `data-composition-variables` JSON, attribute-escaped, with each `default` set to the job's value, so snapshot, check and render see identical values. |
| `KF_FPS` | `template.json` → `fps`. |
| `KF_ASPECT` / `KF_ASPECT_RATIO` | `9x16`/`1x1`/`16x9` (for `data-kf-aspect`, which `tokens.css` keys on) and `9:16`/… |
| `KF_STYLE` | The job's style id. |
| `KF_TEMPLATE_ID`, `KF_TEMPLATE_VERSION` | From `template.json`. |

Job directory: the template's files at the root (`index.html`, `styles/`, …), the kit under `kit/`, job assets
(logos) under `assets/` (downloaded and sha256-checked by the worker), and `vars.json`. To look at a stamped job
in Studio: `node apps/worker/src/cli.ts stamp --template countdown --aspect 9:16 --out /tmp/cd && npx hyperframes
preview /tmp/cd --no-open`.

## Template hash (`spec.template.hash`)

`templateHash = sha256( "keyframe-stamp/v1\n" ‖ lines )`. There is one line per bundle file, `"<sha256 hex>  <path>\n"`,
sorted by path in byte order. The paths are job-relative: template files minus `*.md`, `design/` and dotfiles, plus
`_kit` files minus `*.md`, mounted as `kit/...`. `index.tmpl.html` is hashed as authored. The watermark is excluded,
because it never touches a master. Reproduce it without the worker:

```sh
cd templates && T=countdown
{ printf 'keyframe-stamp/v1\n'
  { (cd $T && find . -type f -not -path '*/.*' ! -name '*.md' ! -path './design/*' | sed 's#^\./##')
    (cd _kit && find . -type f -not -path '*/.*' ! -name '*.md' | sed 's#^\./#kit/#'); } | LC_ALL=C sort |
  while read -r p; do case $p in kit/*) f=_kit/${p#kit/};; *) f=$T/$p;; esac
    printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$p"; done; } | shasum -a 256
```

`node apps/worker/src/cli.ts templates` prints every hash. The worker publishes them in its heartbeat, and it refuses
a job whose `template.{version,hash}` differs from what it has on disk.

## Rules every template follows

These are the FIXED section of `_kit/MOTION.md`, from HyperFrames' contract and the builder's measured notes:
- one paused GSAP timeline at `window.__timelines["main"]`, registered after the build (fonts first);
- no clocks, unseeded randomness, timers, `requestAnimationFrame`, network or input state (seed = first 4 bytes of
  `specHash`, passed as a variable);
- `@font-face` inline in `index.tmpl.html`, pointing at `kit/fonts/...`; families named literally;
- buyer text only through `data-var-text`/`textContent`, never `innerHTML`; no `<br>`; never change text through
  GSAP (it coerces `"07"` to `7`), toggle pre-rendered states instead;
- transforms and opacity for motion; never tween `display`/`visibility`/`autoAlpha` on a timed element.

## Acceptance gate

```sh
node apps/worker/src/cli.ts check --template <id> --extremes   # strict 'hyperframes check' (lint, runtime, layout
                                                               # incl. transition seams, contrast) for every aspect
                                                               # x duration, with defaults and max-length values
node apps/worker/src/cli.ts render --template <id> --out out/<id> --seal   # still + master + preview + KFC1 round trip
```

Then the builder reviews the frames by eye. That is product-render-demo B2's "personally reviews the contact sheet",
and no automated gate replaces it.

License: templates are all rights reserved (the builder's work). `_kit/vendor` (GreenSock standard no-charge
license) and `_kit/fonts` (SIL OFL 1.1) keep their own licences.
