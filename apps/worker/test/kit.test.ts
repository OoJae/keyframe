import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { isRenderable, listTemplateIds, loadTemplate } from "../src/templates.ts";
import { TEMPLATES } from "./helpers.ts";

const sha = async (f: string) =>
  createHash("sha256")
    .update(await readFile(f))
    .digest("hex");
const require = createRequire(import.meta.url);

describe("kit", () => {
  it("vendored GSAP is byte-identical to the pinned gsap@3.15.0", async () => {
    const gsapDir = path.dirname(require.resolve("gsap/package.json"));
    assert.equal((require("gsap/package.json") as { version: string }).version, "3.15.0");
    for (const f of ["gsap.min.js", "CustomEase.min.js"]) {
      assert.equal(await sha(path.join(TEMPLATES, "_kit/vendor", f)), await sha(path.join(gsapDir, "dist", f)), f);
    }
    const readme = await readFile(path.join(TEMPLATES, "_kit/vendor/README.md"), "utf8");
    assert.ok(readme.includes(await sha(path.join(TEMPLATES, "_kit/vendor/gsap.min.js"))));
  });

  it("the reference font matches the hash in fonts/README.md and ships with its licence", async () => {
    const font = path.join(TEMPLATES, "_kit/fonts/reference-sans/inter-latin-wght-normal.woff2");
    const readme = await readFile(path.join(TEMPLATES, "_kit/fonts/README.md"), "utf8");
    assert.ok(readme.includes(await sha(font)));
    assert.match(
      await readFile(path.join(TEMPLATES, "_kit/fonts/reference-sans/OFL.txt"), "utf8"),
      /SIL OPEN FONT LICENSE/i,
    );
  });

  it("every local asset a renderable template references exists, and nothing is loaded from the network", async () => {
    for (const id of await listTemplateIds(TEMPLATES)) {
      const t = await loadTemplate(TEMPLATES, id);
      if (!isRenderable(t.meta)) continue;
      const html = await readFile(path.join(t.dir, "index.tmpl.html"), "utf8");
      assert.ok(
        !/(src|href)\s*=\s*["']?https?:/i.test(html) && !/url\(\s*['"]?https?:/i.test(html),
        `${id}: no remote assets`,
      );
      for (const m of html.matchAll(/(?:src|href)="([^"{}]+)"|url\('([^'{}]+)'\)/g)) {
        const ref = m[1] ?? m[2] ?? "";
        const file = ref.startsWith("kit/") ? path.join(TEMPLATES, "_kit", ref.slice(4)) : path.join(t.dir, ref);
        assert.ok(existsSync(file), `${id}: ${ref} exists`);
      }
      for (const style of t.meta.styles)
        assert.ok(existsSync(path.join(t.dir, "styles", `${style}.css`)), `${id}: style ${style}`);
      assert.ok(
        !/Math\.random|Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame|innerHTML/.test(html),
        `${id}: determinism bans`,
      );
    }
  });
});
