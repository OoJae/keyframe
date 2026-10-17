# ADR-018: Template system (stamped HyperFrames compositions, hashed bundles, human-designed)

- Status: accepted (engineering; the designs themselves are the builder's)
- Date: 2026-10-17
- Area: `templates/`, `apps/worker/src/{templates,stamp,vars,watermark}.ts`

## Context

Templates are where the human craft shows (product-render-demo B2), and the hackathon can disqualify AI-made work
without meaningful human contribution. So engineering must ship the machinery but not the designs. HyperFrames
fixes the root `data-duration`/`data-width`/`data-height` at compile time, and `snapshot` takes no variables. The
spec commits to `template.{id,version,hash}`, so the hash must be reproducible without the worker.

## Decision

1. **`template.json` per template**, validated by zod in the worker (`templates/template.schema.json` is generated
   from it, and a test fails on drift). It holds the id, semver, spec format, a status of `production`, `reference`,
   `awaiting-design` or `kit`, styles, aspects (sizes fixed to 1080×1920 / 1080×1080 / 1920×1080), fps, durations,
   a hero time per duration (a whole frame inside the clip, `null` only while awaiting design), a perf budget and
   typed variables. The variables add worker-enforced limits (maxLength, pattern, json, min/max/integer, enum
   options, and no control characters) on top of HyperFrames' `--strict-variables` type check.
2. **Stamping.** `index.tmpl.html` uses ten `{{KF_*}}` tokens. Width, height, duration and variables are required,
   and any other `{{…}}` is an error, checked on the template source so buyer text containing braces is harmless.
   The variable declarations are stamped with the job's values as defaults, so `snapshot`, `check` and `render` see
   identical inputs, and render also gets `--variables-file`. Values are attribute-escaped. The kit is copied to
   `kit/` in every job, and nothing is fetched at render time.
3. **Template hash** = `sha256("keyframe-stamp/v1\n" + sha256sum-style lines)` over the job-relative bundle (the
   template minus `*.md`, `design/` and dotfiles, plus `_kit` minus `*.md`). It can be reproduced with `find | sort
   | shasum` (recipe in `templates/README.md`, equality tested).
4. **Watermark as a composition.** `_watermark` is authored white-on-black, snapshotted once per aspect and turned
   into an RGBA tile (alpha = luma × opacity) with ffmpeg. The tile is cached under a key of its template hash and
   opacity. It is composited onto the still (PNG, 540p) and the preview, never onto the master.
5. **Human-craft rule.** Only two deliberately plain REFERENCE templates are implemented: `countdown` and `probe`.
   They use neutral tokens and one OFL placeholder face, and say "REFERENCE IMPLEMENTATION - replace with the
   builder's own design". `launch_sting`, `portfolio_pulse`, `kinetic_post` and `chart_moment` ship as variable
   schemas only. `_kit/MOTION.md` is a skeleton whose design sections are all TODO(builder), and palette presets
   (`_kit/palettes.json`) are `null` until designed.
6. **Gate.** `cli.ts check --all --extremes` runs strict `hyperframes check` (lint, runtime, layout including
   transition seams, contrast) for every template × aspect × duration, with both defaults and worst-case values.
   The builder still reviews frames by eye, because the layout audit is not sufficient: it passed a 9:16 CTA pill
   that bled past both frame edges, which was found by looking and then fixed.

## Consequences

- Shipping a new format is: design it, add `index.tmpl.html` + `styles/<style>.css`, add its `toTemplateVars`
  mapper in `apps/worker/src/vars.ts`, set status `production`, then pass the gate. The plugin is unaffected
  (catalog and templates are server-side).
- Lessons recorded in `_kit/MOTION.md` (FIXED): never change text through GSAP, because `tl.set(el, {textContent:"07"})`
  renders `7`. Pre-render states and toggle their opacity instead.
- The API catalog names some templates with hyphens (`launch-sting`). The worker resolves `-` to `_` and reports the
  API's id back unchanged.
