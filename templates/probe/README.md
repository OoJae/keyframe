# probe

> **REFERENCE IMPLEMENTATION - replace with the builder's own design.**
> A plain test card. It is the hidden `probe` SKU (product-render-demo A2: 2 s, 0.10 USDC) used for synthetic
> monitoring, so it may well stay functional, but its look is not Keyframe's.

2 s, 30 fps, hero frame at 1.0 s. Sold under spec format `catalog`.

What each frame carries, so a decoded frame can be checked against its index without trusting the pipeline:
- `F NN`: the output frame index (0–59), and `T+s.sss`: that frame's time. Both are set once per frame at `i/fps`.
- A white block sweeping linearly across a track (motion and frame-order check).
- 75% colour bars (white, yellow, cyan, green, magenta, red, blue) and corner marks (crop and scaling check).
- The resolution, aspect, fps and duration line, read from the stamped root attributes.

| Variable | Type | Notes |
|---|---|---|
| `probe_id` | string 1–32, `[A-Za-z0-9_-]` | Run id of the synthetic order. |
