# Fonts

Every font a template uses ships here as a local `.woff2` file, with its licence next to it. Renders never fetch
fonts, and they never rely on system fonts. Each machine has a different fallback, so if a quote-time still is
rendered on one worker and the master on another, the type would not match.

## What is here now

| Directory | Family name to use in CSS | Source | Licence | Coverage |
|---|---|---|---|---|
| `reference-sans/` | `'KF Reference Sans'` | Inter (latin subset, variable `wght` 100–900), from npm `@fontsource-variable/inter@5.3.0`, `files/inter-latin-wght-normal.woff2` | SIL OFL 1.1 (`OFL.txt`) | U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD |

`reference-sans` exists only so that the reference templates (`countdown`, `probe`) render the same on every
host. It is a neutral placeholder and not a brand choice. The family is registered under a Keyframe-specific name
on purpose: HyperFrames auto-resolves some well-known family names, and this one must never resolve to anything
but the local file.

sha256 of `reference-sans/inter-latin-wght-normal.woff2`:
`3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62`

## TODO(builder): add your fonts

1. Put each face in its own directory: `fonts/<family-slug>/<file>.woff2` plus its licence file (OFL or equivalent).
   Only redistributable licences belong here, because the files end up inside every job directory.
2. Declare it **inline in each composition file** (`index.tmpl.html`), never in a linked stylesheet:
   ```css
   @font-face { font-family: 'Your Family'; src: url('kit/fonts/<family-slug>/<file>.woff2') format('woff2');
                font-weight: 400 700; font-display: block; }
   ```
   In the job directory the kit is mounted at `kit/`, so `kit/fonts/...` is the path to use.
3. Name the family literally in `font-family` (not through `var()`), so the lint can see it.
4. Record the glyph coverage in the table above. The API checks buyer text against the shipped fonts' coverage
   at quote time, and text outside the coverage is refused rather than rendered as tofu.
5. Expect every template hash to change. The hash covers the whole kit (see `../../README.md`).
