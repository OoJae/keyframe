# countdown

> **REFERENCE IMPLEMENTATION - replace with the builder's own design.**
> Deliberately plain and functional. It exists to prove the template system, the worker and the delivery pipeline
> end to end at 9:16, 1:1 and 16:9. It is not Keyframe's motion language, and nothing in it should survive into
> the shipped countdown except the variable contract it demonstrates.

"T-minus" launch card, 8 s, 30 fps. Hero frame (the quote-time still) at 3.0 s, when every element has landed.

| Variable | Type | Notes |
|---|---|---|
| `label` | string 1–32 | Shrink-to-fit on one line (`fitTextFontSize`), wraps as a last resort. |
| `target_text` | string ≤ 40 | Pre-formatted by the API from `params.target` + `tz_label`. Wraps (balanced). |
| `remaining_s` | integer 0–86 399 999 | Seconds left at the first frame = target minus the spec's time anchor. The readout ticks once per second; days go to 3 digits from 100 days. |
| `cta` | string ≤ 24 | Empty hides the pill. |
| `bg`, `fg`, `accent` | `#rrggbb` | Resolved palette. |

Mechanics worth keeping when redesigning:
- The tick: each digit cell holds one stacked span per value it shows during the clip, and the timeline only toggles
  opacity at whole seconds. That is seekable in any order and identical with any `--workers` count. Setting
  `textContent` through GSAP is a trap, because it coerces `"07"` to `7`.
- The digit size is fitted to the widest readout for this job, so 3-digit days never overflow at 9:16.
- The timeline is built inside `document.fonts.load(...).then(build, build)` and registered last.

Gate: `node apps/worker/src/cli.ts check --template countdown --extremes` (strict, all aspects, defaults and
max-length values).
