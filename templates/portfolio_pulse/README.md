# portfolio_pulse: AWAITING THE BUILDER'S DESIGN

Portfolio card fed verbatim by PayBox `get_portfolio`: the 24h move of current holdings plus the top holdings, 8 s.

This directory holds **only the variable schema** (`template.json`, status `awaiting-design`). There is no
composition here on purpose. Every Keyframe template is designed by hand by the builder (PLAN.md, "Human-contribution
evidence"; product-render-demo B2), and engineering does not draft visuals for these formats. The worker refuses to
render a template whose status is `awaiting-design`.

The variables mirror the frozen `keyframe_quote` params for this format (product-render-demo A3) after the API's
`toTemplateVars()` step: text arrives pre-validated, palette presets arrive resolved to `bg`/`fg`/`accent`,
arrays travel as JSON strings, and numbers in the spec are integers.

- Copy rule (A2): it reads "24h move of current holdings", never "PnL". Unpriced holdings show as "—".
- Spec params are integers only (JCS profile, frozen-interfaces §6), so changes travel as basis points; the API formats money as text.
- Private delivery by default. Hero time 5.8 s (all values landed).

## To ship it (TODO(builder))

1. Design it (storyboard and style frames in `design/`, which is excluded from the template hash) using the
   language in `../_kit/MOTION.md`.
2. Add `index.tmpl.html` and `styles/<style>.css`. The stamping contract and the rules are in `../README.md`.
3. Adjust the variables if the design needs different ones (they are server-side and not frozen in the plugin).
4. Set `status` to `production`, list the `styles`, fill any `null` hero time, and bump `version`.
5. Gate: `node apps/worker/src/cli.ts check --template portfolio_pulse --extremes` passes for every aspect, then render it
   with `node apps/worker/src/cli.ts render --template portfolio_pulse --out out/portfolio_pulse --seal` and review the contact sheet.

License: all rights reserved (templates are the builder's work; see PLAN.md, "Licences").
