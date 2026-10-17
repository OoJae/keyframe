import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { stamp, stampHtml, TOKENS } from "../src/stamp.ts";
import { loadTemplate, type TemplateError, validateValues } from "../src/templates.ts";
import { TEMPLATES, tempDir, unescapeAttr } from "./helpers.ts";

const countdown = await loadTemplate(TEMPLATES, "countdown");
const defaults = validateValues(countdown.meta, {}, true);
const tokenValues = Object.fromEntries(TOKENS.map((t) => [t, `<${t}>`])) as Record<(typeof TOKENS)[number], string>;

describe("stamp", () => {
  it("writes a concrete job directory for each aspect", async () => {
    for (const [aspect, w, h] of [
      ["9:16", 1080, 1920],
      ["1:1", 1080, 1080],
      ["16:9", 1920, 1080],
    ] as const) {
      const out = path.join(await tempDir(), "job");
      const s = await stamp({
        templatesDir: TEMPLATES,
        template: countdown,
        aspect,
        durationS: 8,
        style: "tminus",
        values: defaults,
        outDir: out,
      });
      assert.equal(s.width, w);
      assert.equal(s.height, h);
      assert.equal(s.heroTimeS, 3);
      const html = await readFile(s.indexPath, "utf8");
      assert.ok(!html.includes("{{"), "no tokens left");
      assert.match(html, new RegExp(`data-width="${w}"`));
      assert.match(html, new RegExp(`data-height="${h}"`));
      assert.match(html, /data-duration="8"/);
      assert.match(html, new RegExp(`data-kf-aspect="${aspect.replace(":", "x")}"`));
      assert.match(html, /href="styles\/tminus.css"/);
      assert.deepEqual(JSON.parse(await readFile(s.varsPath, "utf8")), defaults);
      for (const f of [
        "styles/tminus.css",
        "kit/vendor/gsap.min.js",
        "kit/styles/tokens.css",
        "kit/fonts/reference-sans/inter-latin-wght-normal.woff2",
      ]) {
        assert.ok(existsSync(path.join(out, f)), `${f} copied`);
      }
      for (const f of ["template.json", "README.md", "index.tmpl.html", "kit/MOTION.md"]) {
        assert.ok(!existsSync(path.join(out, f)), `${f} not copied`);
      }
    }
  });

  it("puts the job's values in the variable defaults, attribute-escaped, braces untouched", async () => {
    const out = path.join(await tempDir(), "job");
    const label = `"><script>x</script> & 'q' {{KF_WIDTH}}`.slice(0, 32);
    const values = { ...defaults, label };
    const s = await stamp({
      templatesDir: TEMPLATES,
      template: countdown,
      aspect: "1:1",
      durationS: 8,
      style: "tminus",
      values,
      outDir: out,
    });
    const html = await readFile(s.indexPath, "utf8");
    const m = /<html lang="en" data-composition-variables="([^"]*)">/.exec(html);
    assert.ok(m?.[1], "declarations attribute present and double-quote safe");
    const decl = JSON.parse(unescapeAttr(m[1])) as { id: string; type: string; default: unknown }[];
    assert.deepEqual(
      decl.map((d) => d.id),
      countdown.meta.variables.map((v) => v.id),
    );
    assert.equal(decl.find((d) => d.id === "label")?.default, label);
    assert.equal(decl.find((d) => d.id === "remaining_s")?.default, defaults.remaining_s);
    assert.ok(!html.includes("<script>x</script>"), "markup in values never reaches the document unescaped");
  });

  it("refuses requests template.json does not allow", async () => {
    const out = path.join(await tempDir(), "job");
    const req = {
      templatesDir: TEMPLATES,
      template: countdown,
      aspect: "9:16" as const,
      durationS: 8,
      style: "tminus",
      values: defaults,
      outDir: out,
    };
    await assert.rejects(stamp({ ...req, durationS: 6 }), (e: TemplateError) => e.code === "bad_duration");
    await assert.rejects(stamp({ ...req, style: "neon" }), (e: TemplateError) => e.code === "bad_style");
    await assert.rejects(
      stamp({ ...req, values: { ...defaults, extra: 1 } }),
      (e: TemplateError) => e.code === "bad_variables",
    );
    const sting = await loadTemplate(TEMPLATES, "launch_sting");
    await assert.rejects(
      stamp({ ...req, template: sting, durationS: 6 }),
      (e: TemplateError) => e.code === "not_renderable",
    );
  });
});

describe("stampHtml", () => {
  const ok = "{{KF_WIDTH}}{{KF_HEIGHT}}{{KF_DURATION}}{{KF_VARIABLES}}";
  it("replaces every known token", () => {
    assert.equal(
      stampHtml(`${ok} {{ KF_STYLE }}`, tokenValues),
      "<KF_WIDTH><KF_HEIGHT><KF_DURATION><KF_VARIABLES> <KF_STYLE>",
    );
  });
  it("rejects unknown, missing and malformed tokens", () => {
    assert.throws(() => stampHtml(`${ok}{{KF_NOPE}}`, tokenValues), /unknown token/);
    assert.throws(() => stampHtml("{{KF_WIDTH}}{{KF_HEIGHT}}{{KF_DURATION}}", tokenValues), /KF_VARIABLES/);
    assert.throws(() => stampHtml(`${ok}{{KF_*}}`, tokenValues), /malformed/);
    assert.throws(() => stampHtml(`${ok}{{`, tokenValues), /malformed/);
  });
});
