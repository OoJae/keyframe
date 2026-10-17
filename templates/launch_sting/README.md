# launch_sting: AWAITING THE BUILDER'S DESIGN

Wordmark/logo + tagline brand sting, 6 s or 10 s. The hero format and the demo order (the Ripcord sting).

This directory holds **only the variable schema** (`template.json`, status `awaiting-design`). There is no
composition here on purpose. Every Keyframe template is designed by hand by the builder (PLAN.md, "Human-contribution
evidence"; product-render-demo B2), and engineering does not draft visuals for these formats. The worker refuses to
render a template whose status is `awaiting-design`.

The variables mirror the frozen `keyframe_quote` params for this format (product-render-demo A3) after the API's
`toTemplateVars()` step: text arrives pre-validated, palette presets arrive resolved to `bg`/`fg`/`accent`,
arrays travel as JSON strings, and numbers in the spec are integers.

- `logo_src` points at a file inside the job directory (`assets/<name>`). Templates never fetch. When this format ships, the worker's `toTemplateVars` step must download `params.logo_url` (https only, at most 2 MB, PNG/WebP, SVG rasterised first) into `assets/` before rendering, per product-render-demo B3.
- Hero times come from product-render-demo A2: 3.4 s (6 s cut) and 5.0 s (10 s cut), the moment the lockup is legible.

## To ship it (TODO(builder))

1. Design it (storyboard and style frames in `design/`, which is excluded from the template hash) using the
   language in `../_kit/MOTION.md`.
2. Add `index.tmpl.html` and `styles/<style>.css`. The stamping contract and the rules are in `../README.md`.
3. Adjust the variables if the design needs different ones (they are server-side and not frozen in the plugin).
4. Set `status` to `production`, list the `styles`, fill any `null` hero time, and bump `version`.
5. Gate: `node apps/worker/src/cli.ts check --template launch_sting --extremes` passes for every aspect, then render it
   with `node apps/worker/src/cli.ts render --template launch_sting --out out/launch_sting --seal` and review the contact sheet.

License: all rights reserved (templates are the builder's work; see PLAN.md, "Licences").
