import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadTemplate, TemplateError } from "../src/templates.ts";
import { formatTarget, hasMapper, resolvePalette, toTemplateVars } from "../src/vars.ts";
import { TEMPLATES } from "./helpers.ts";

const countdown = (await loadTemplate(TEMPLATES, "countdown")).meta;
const probe = (await loadTemplate(TEMPLATES, "probe")).meta;
const anchorS = Date.UTC(2026, 9, 17, 12, 0, 0) / 1000;
const q = "q_1111111111111111111111";

describe("toTemplateVars", () => {
  it("formats UTC times without locale dependence", () => {
    assert.equal(formatTarget("2026-10-24T18:00:00Z"), "Oct 24 · 18:00 UTC");
    assert.equal(formatTarget("2027-01-05T03:07:59.999Z"), "Jan 5 · 03:07 UTC");
    assert.throws(() => formatTarget("tomorrow"), TemplateError);
  });

  it("shows the buyer's own offset and timezone label, and never labels a UTC time as local", () => {
    assert.equal(formatTarget("2026-10-24T19:00:00+01:00", "WAT"), "Oct 24 · 19:00 WAT");
    assert.equal(formatTarget("2026-10-24T19:00:00+01:00"), "Oct 24 · 19:00 UTC+1");
    assert.equal(formatTarget("2026-10-24T23:30:00+05:30", "IST"), "Oct 24 · 23:30 IST");
    assert.equal(formatTarget("2026-10-24T23:30:00+0530"), "Oct 24 · 23:30 UTC+5:30");
    assert.equal(formatTarget("2026-10-24T21:00:00-03:00"), "Oct 24 · 21:00 UTC-3");
    // crossing midnight in local time keeps the local date
    assert.equal(formatTarget("2026-10-25T00:30:00+01:00", "BST"), "Oct 25 · 00:30 BST");
    assert.equal(formatTarget("2026-10-24T18:00:00Z", "WAT"), "Oct 24 · 18:00 UTC");
    assert.equal(formatTarget("2026-10-24T18:00:00+00:00", "GMT"), "Oct 24 · 18:00 UTC");
    // labels that aren't plain zone names fall back to the numeric offset
    assert.equal(formatTarget("2026-10-24T19:00:00+01:00", "<b>x</b>"), "Oct 24 · 19:00 UTC+1");
    assert.equal(formatTarget("2026-10-24T19:00:00+01:00", " "), "Oct 24 · 19:00 UTC+1");
  });

  it("maps countdown params, clamps remaining time and applies a custom palette", async () => {
    const v = await toTemplateVars(TEMPLATES, countdown, {
      params: {
        style: "tminus",
        label: "Mainnet",
        target: "2026-10-24T18:00:00Z",
        sound: "studio",
        receipt_end_card: true,
        palette: { bg: "#000000", fg: "#ffffff", accent: "#888888" },
      },
      quoteId: q,
      anchorS,
    });
    assert.deepEqual(v, {
      label: "Mainnet",
      target_text: "Oct 24 · 18:00 UTC",
      remaining_s: 7 * 86400 + 6 * 3600,
      cta: "",
      bg: "#000000",
      fg: "#ffffff",
      accent: "#888888",
    });
    const past = await toTemplateVars(TEMPLATES, countdown, {
      params: { label: "x", target: "2020-01-01T00:00:00Z" },
      quoteId: q,
      anchorS,
    });
    assert.equal(past.remaining_s, 0);
    const local = await toTemplateVars(TEMPLATES, countdown, {
      params: { label: "Launch", target: "2026-10-24T19:00:00+01:00", tz_label: "WAT" },
      quoteId: q,
      anchorS,
    });
    assert.equal(local.target_text, "Oct 24 · 19:00 WAT");
    assert.equal(local.remaining_s, 7 * 86400 + 6 * 3600);
    const far = await toTemplateVars(TEMPLATES, countdown, {
      params: { label: "x", target: "2099-01-01T00:00:00Z" },
      quoteId: q,
      anchorS,
    });
    assert.equal(far.remaining_s, 86399999);
  });

  it("falls back to template colours for presets not designed yet, and rejects unknown ones", async () => {
    const v = await toTemplateVars(TEMPLATES, countdown, {
      params: { label: "x", target: "2026-10-24T18:00:00Z", palette: "void" },
      quoteId: q,
      anchorS,
    });
    assert.equal(v.bg, "#101010");
    assert.equal(await resolvePalette(TEMPLATES, "ember"), null);
    await assert.rejects(resolvePalette(TEMPLATES, "neon"), TemplateError);
    await assert.rejects(resolvePalette(TEMPLATES, "//"), TemplateError);
    await assert.rejects(resolvePalette(TEMPLATES, "constructor"), TemplateError);
    await assert.rejects(resolvePalette(TEMPLATES, { bg: "red", fg: "#fff", accent: "#000" }), TemplateError);
  });

  it("enforces the template's limits on mapped values", async () => {
    await assert.rejects(
      toTemplateVars(TEMPLATES, countdown, {
        params: { label: "x".repeat(40), target: "2026-10-24T18:00:00Z" },
        quoteId: q,
        anchorS,
      }),
      TemplateError,
    );
    await assert.rejects(
      toTemplateVars(TEMPLATES, countdown, { params: { label: "x" }, quoteId: q, anchorS }),
      TemplateError,
    );
  });

  it("maps probe values, falling back to the quote id", async () => {
    assert.deepEqual(
      await toTemplateVars(TEMPLATES, probe, {
        params: { catalog_id: "probe", values: { probe_id: "run-7" } },
        quoteId: q,
        anchorS,
      }),
      { probe_id: "run-7" },
    );
    assert.deepEqual(
      await toTemplateVars(TEMPLATES, probe, {
        params: { catalog_id: "probe", values: { probe_id: "bad id!" } },
        quoteId: q,
        anchorS,
      }),
      { probe_id: q },
    );
  });

  it("has mappers only for the renderable reference templates", () => {
    assert.deepEqual(["countdown", "probe", "launch_sting", "kinetic_post"].map(hasMapper), [true, true, false, false]);
  });
});
