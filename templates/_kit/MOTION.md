# Keyframe motion language (MOTION.md)

> **Status: SKELETON.** Every section marked **TODO(builder)** is the designer's to write. Nothing in those
> sections has been decided. Engineering only filled in the parts that are technical constraints (marked
> **FIXED**), which every template has to respect whatever the visual language turns out to be.
> The reference templates (`countdown`, `probe`) deliberately use none of the language below. They use plain
> neutral tokens from `styles/tokens.css`, so that nothing in them can be mistaken for the house style.

This document is part of the human-contribution evidence (PLAN.md, "Human-contribution evidence"). Write it in your
own voice and commit its iterations.

---

## 1. Principles — TODO(builder)

What a Keyframe piece feels like in one paragraph, and three to five rules a template must obey to belong to the
family (for example: what moves first, what never moves, how a frame resolves).

- TODO
- TODO
- TODO

## 2. Time — TODO(builder), with FIXED constraints

**TODO(builder):** beat grid (for example 1 beat = N frames at 30 fps), entrance and exit lengths, how long a
lockup must hold to be legible, how the end card hands off.

**FIXED:**
- Output is 30 fps (`template.json` → `fps`). Every authored time should land on the 1/30 s grid.
- Root `data-duration` is stamped per job from `template.json` → `durations`; a timeline that runs past it is cut,
  one that ends early holds its last frame.
- Each duration has a **hero time** (`template.json` → `heroTime`): the frame the buyer approves as the quote-time
  still. It must be a frame where everything that matters is on screen and settled. The worker refuses a hero
  time that is not a whole frame.

## 3. Easing — TODO(builder)

Named eases registered with `CustomEase` (vendored in `vendor/CustomEase.min.js`). The product design reserves
these names; their curves are yours to draw:

| Name | Use | Curve |
|---|---|---|
| `kf.lift` | TODO | TODO (`M0,0 C… 1,1`) |
| `kf.seal` | TODO | TODO |
| `kf.settle` | TODO | TODO |

Register them once per composition, before building the timeline:
`gsap.registerPlugin(CustomEase); CustomEase.create("kf.lift", "<path>");`

## 4. Type — TODO(builder)

- Families (ship them in `fonts/`, see `fonts/README.md`): TODO
- Scale per aspect (9:16 1080×1920, 1:1 1080×1080, 16:9 1920×1080): TODO
- Rules for buyer-supplied text (shrink-to-fit floor, max lines, when to refuse at quote time): TODO

**FIXED:** buyer text is sized with `window.__hyperframes.fitTextFontSize` after the font has loaded
(`document.fonts.load(...)`). Never use `<br>` in buyer text, and keep every line inside its box at the longest
allowed input (`template.json` → `variables[].maxLength`). `hyperframes check` must pass at those extremes.

## 5. Colour — TODO(builder)

The quote schema already names five builder-designed presets: `void`, `paper`, `signal`, `mono`, `ember`. Each
resolves to `{bg, fg, accent}` in the API before a job is sent, and reaches a template as the `bg`, `fg` and
`accent` variables (CSS `--bg`, `--fg`, `--accent` on the root).

| Preset | bg | fg | accent | Notes |
|---|---|---|---|---|
| `void` | TODO | TODO | TODO | |
| `paper` | TODO | TODO | TODO | |
| `signal` | TODO | TODO | TODO | |
| `mono` | TODO | TODO | TODO | |
| `ember` | TODO | TODO | TODO | |

**FIXED:** fg on bg must meet WCAG 4.5:1 (the API enforces it on custom palettes; `hyperframes check` runs the
contrast pass on every template).

## 6. Glyphs and marks — TODO(builder)

The product design names these: envelope, seal, key, clock, hash-glyph. Draw them as SVG in `glyphs/` (TODO: create),
with a short note on when each one appears.

## 7. Texture and grain — TODO(builder), with FIXED constraints

**FIXED:** any randomness comes from a seeded PRNG (mulberry32 or similar). The seed is the first 4 bytes of the
job's `specHash` and arrives as a variable, so each piece is unique but reproducible. `Math.random()`,
`Date.now()`, `performance.now()`, timers and `requestAnimationFrame` loops are banned for visual state.
Grain is a small tiled layer, static or stepped (for example at 12 fps), never full-frame noise video.

## 8. Sound — TODO(builder)

SFX set (pre-normalised to −16 LUFS WAV, 48 kHz), when sound is used, and the `sound: "none"` variant.
Every `<audio>` needs an `id` or the mixer drops it.

## 9. Watermark and preview — TODO(builder)

The watermark tile composited onto quote-time stills and 540p previews is the composition in `../_watermark/`. The
current tile is a plain reference (`../_watermark/README.md`). Design the real one: legible enough to stop reuse,
light enough to judge the motion through it.

## 10. End card ("credits are receipts") — TODO(builder)

The optional 1.2 s end card (`receipt_end_card`): envelope address, funding tx, designer credit. Layout and motion TODO.

## 11. Per-format notes — TODO(builder)

One short section per format: the idea, the storyboard, the hero frame, and what the variables are allowed to do.

- `launch_sting`: TODO
- `countdown`: TODO (the shipped one is a reference only)
- `portfolio_pulse`: TODO
- `kinetic_post`: TODO
- `chart_moment`: TODO

---

## FIXED: engineering constraints for every template

These come from HyperFrames' contract and the builder's own measured notes (`HYPERFRAMES_NOTES.md`):

1. One paused GSAP timeline per composition, registered as `window.__timelines["main"]` **after** the build
   finishes (it may be built inside a `document.fonts.load(...).then(...)` callback).
2. Animate transforms and opacity. No animated full-frame `filter: blur()`. An animated `clip-path`, mask,
   blend mode or 3D transform switches off fast capture.
3. Never tween `display`, `visibility` or `autoAlpha` on a timed (`data-start`) element; animate a child.
4. Never set a CSS `transform` and tween the same property in GSAP; put both ends in `fromTo`.
5. Buyer text enters through `data-var-text` or `textContent`, never `innerHTML`.
   Do not change text through GSAP (`tl.set(el, {textContent: "07"})`). GSAP treats a numeric-looking string as a
   number and writes `7`; this was found in the reference countdown. Pre-render each state and toggle its opacity
   instead (see `countdown/index.tmpl.html`).
6. No network at render time: every asset is in the template, in `kit/`, or downloaded by the worker into
   `assets/` before rendering (with its sha256 checked).
7. Perf budget (`template.json` → `perf`): a 6 s 1080×1920 render in ≤ 45 s on the 4 vCPU VPS.
8. Acceptance: `node apps/worker/src/cli.ts check --template <id>` passes for every aspect.
