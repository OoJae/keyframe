# _watermark (kit)

> **REFERENCE IMPLEMENTATION - replace with the builder's own design.**

The tile composited over every quote-time still and every 540p preview. It is a HyperFrames composition like any
template, authored **white on black**. The worker snapshots it once per aspect and converts brightness into alpha
(`alpha = luma × overlay.opacity`, `template.json` → `overlay.opacity`, currently 0.22). The result is cached under
`$WORK_DIR/tiles/<hash>/`, keyed by this template's hash and the opacity, so editing anything here regenerates the
tiles on the next job.

It never touches the master, so it is outside every format template's hash.

TODO(builder): the real tile (legible enough to stop reuse, light enough to judge the motion through it). Product
notes (B4) mention a per-quote label, for example `KEYFRAME · PREVIEW · KF-7Q2M`. That needs one extra snapshot per
quote (2–5 s), which is too slow for the 4.5 s still budget, so the reference tile is static.
