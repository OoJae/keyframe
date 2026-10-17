import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  bundleFiles,
  isRenderable,
  jsonSchema,
  listTemplateIds,
  loadTemplate,
  STAMP_VERSION,
  type Template,
  TemplateError,
  TemplateSchema,
  templateHash,
  validateValues,
} from "../src/templates.ts";
import { TEMPLATES } from "./helpers.ts";

const countdown = async () => (await loadTemplate(TEMPLATES, "countdown")).meta;
const COUNTDOWN: Template = await countdown();
const COUNTDOWN_DEFAULTS: Record<string, unknown> = Object.fromEntries(
  COUNTDOWN.variables.map((v) => [v.id, v.default]),
);

describe("template.json files", () => {
  it("every template in templates/ validates and matches its directory", async () => {
    const ids = await listTemplateIds(TEMPLATES);
    assert.deepEqual(ids, [
      "_watermark",
      "chart_moment",
      "countdown",
      "kinetic_post",
      "launch_sting",
      "portfolio_pulse",
      "probe",
    ]);
    for (const id of ids) {
      const t = await loadTemplate(TEMPLATES, id);
      assert.equal(t.meta.id, id);
      assert.match(t.hash, /^0x[0-9a-f]{64}$/);
    }
  });

  it("only countdown and probe are renderable formats; the four designs await the builder", async () => {
    const status: Record<string, string> = {};
    for (const id of await listTemplateIds(TEMPLATES)) status[id] = (await loadTemplate(TEMPLATES, id)).meta.status;
    assert.deepEqual(status, {
      _watermark: "kit",
      chart_moment: "awaiting-design",
      countdown: "reference",
      kinetic_post: "awaiting-design",
      launch_sting: "awaiting-design",
      portfolio_pulse: "awaiting-design",
      probe: "reference",
    });
    for (const id of ["launch_sting", "portfolio_pulse", "kinetic_post", "chart_moment"]) {
      const dir = await readdir(path.join(TEMPLATES, id));
      assert.deepEqual(dir.sort(), ["README.md", "template.json"], `${id} must hold only its schema and README`);
      assert.equal(isRenderable((await loadTemplate(TEMPLATES, id)).meta), false);
    }
  });

  it("reference templates and the kit say REFERENCE IMPLEMENTATION in their README", async () => {
    for (const id of ["countdown", "probe", "_watermark"]) {
      const readme = await readFile(path.join(TEMPLATES, id, "README.md"), "utf8");
      assert.match(readme, /REFERENCE IMPLEMENTATION - replace with the builder's own design/);
    }
  });

  it("templates/template.schema.json is the generated schema (drift gate)", async () => {
    const committed = JSON.parse(await readFile(path.join(TEMPLATES, "template.schema.json"), "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(jsonSchema())));
  });
});

describe("TemplateSchema rules", () => {
  const base = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path.join(TEMPLATES, "countdown", "template.json"), "utf8"));
  const issues = (t: unknown) => {
    const r = TemplateSchema.safeParse(t);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("accepts the shipped countdown", async () => assert.deepEqual(issues(await base()), []));

  it("rejects a hero time that is not a whole frame or is outside the clip", async () => {
    assert.ok(issues({ ...(await base()), heroTime: { "8": 3.01 } }).some((m) => m.includes("whole frame")));
    assert.ok(issues({ ...(await base()), heroTime: { "8": 8 } }).some((m) => m.includes("inside the clip")));
    assert.ok(issues({ ...(await base()), heroTime: { "8": null } }).some((m) => m.includes("awaiting design")));
    assert.ok(issues({ ...(await base()), heroTime: {} }).some((m) => m.includes("one entry per duration")));
  });

  it("rejects non-canonical aspect sizes, duplicate variables and invalid defaults", async () => {
    const b = await base();
    assert.ok(
      issues({ ...b, aspects: { "9:16": { width: 1080, height: 1080 } } }).some((m) => m.includes("1080x1920")),
    );
    const vars = b.variables as Record<string, unknown>[];
    assert.ok(issues({ ...b, variables: [...vars, vars[0]] }).some((m) => m.includes("duplicate")));
    assert.ok(issues({ ...b, variables: [{ ...vars[0], default: "x".repeat(33) }] }).length > 0);
    assert.ok(issues({ ...b, variables: [{ id: "c", type: "color", label: "c", default: "red" }] }).length > 0);
  });

  it("rejects unknown fields (strict)", async () => {
    assert.ok(issues({ ...(await base()), extra: 1 }).length > 0);
  });
});

describe("validateValues", () => {
  const full = async () => Object.fromEntries((await countdown()).variables.map((v) => [v.id, v.default]));

  it("accepts complete values and returns them in declaration order", async () => {
    const t = await countdown();
    const shuffled = Object.fromEntries(Object.entries(await full()).reverse());
    assert.deepEqual(
      Object.keys(validateValues(t, shuffled)),
      t.variables.map((v) => v.id),
    );
  });

  it("requires every variable unless filling defaults (local CLI only)", async () => {
    const t = await countdown();
    assert.throws(() => validateValues(t, { label: "x" }), TemplateError);
    assert.equal(validateValues(t, { label: "x" }, true).label, "x");
  });

  const bad: [string, Record<string, unknown>][] = [
    ["unknown key", { extra: 1 }],
    ["string too long", { label: "x".repeat(33) }],
    ["string too short", { label: "" }],
    ["control character", { label: "a\u0007b" }],
    ["line separator", { cta: "a b" }],
    ["wrong type", { remaining_s: "10" }],
    ["non-integer", { remaining_s: 1.5 }],
    ["out of range", { remaining_s: -1 }],
    ["bad colour", { bg: "#fff" }],
  ];
  for (const [what, patch] of bad) {
    it(`rejects ${what}`, async () => {
      const err = (() => {
        try {
          validateValues(COUNTDOWN, { ...COUNTDOWN_DEFAULTS, ...patch });
        } catch (e) {
          return e;
        }
      })();
      assert.ok(err instanceof TemplateError && err.code === "bad_variables", `${what} should fail`);
    });
  }

  it("enforces pattern and json flags", async () => {
    const probe = (await loadTemplate(TEMPLATES, "probe")).meta;
    assert.throws(() => validateValues(probe, { probe_id: "has space" }), TemplateError);
    const pp = (await loadTemplate(TEMPLATES, "portfolio_pulse")).meta;
    const ok = Object.fromEntries(pp.variables.map((v) => [v.id, v.default]));
    assert.doesNotThrow(() => validateValues(pp, ok));
    assert.throws(() => validateValues(pp, { ...ok, holdings_json: "[not json" }), TemplateError);
  });
});

describe("templateHash", () => {
  it("is deterministic and equals an independent recomputation of the documented algorithm", async () => {
    for (const id of ["countdown", "probe", "_watermark"]) {
      const a = await templateHash(TEMPLATES, id);
      assert.equal(await templateHash(TEMPLATES, id), a);
      const files = await bundleFiles(TEMPLATES, id);
      const paths = files.map(([p]) => p);
      assert.deepEqual(paths, [...paths].sort(), "byte-sorted paths");
      assert.ok(paths.includes("index.tmpl.html") && paths.includes("template.json"));
      assert.ok(paths.includes("kit/vendor/gsap.min.js") && paths.includes("kit/styles/tokens.css"));
      assert.ok(!paths.some((p) => p.endsWith(".md") || p.startsWith("design/")), "docs and design excluded");
      let text = `${STAMP_VERSION}\n`;
      for (const [rel, abs] of files)
        text += `${createHash("sha256")
          .update(await readFile(abs))
          .digest("hex")}  ${rel}\n`;
      assert.equal(a, `0x${createHash("sha256").update(text).digest("hex")}`);
    }
  });

  it("differs between templates", async () => {
    assert.notEqual(await templateHash(TEMPLATES, "countdown"), await templateHash(TEMPLATES, "probe"));
  });
});
