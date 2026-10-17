// Template metadata, bundled at build time from templates/<id>/template.json (the builder's files; read-only here).
// The render worker loads the same files, so styles, durations, hero frames and readiness have one source of truth:
// a format is sellable only when its template's status is `reference` or `production` and it declares styles.

import palettes from "../../../templates/_kit/palettes.json" with { type: "json" };
import chartMoment from "../../../templates/chart_moment/template.json" with { type: "json" };
import countdown from "../../../templates/countdown/template.json" with { type: "json" };
import kineticPost from "../../../templates/kinetic_post/template.json" with { type: "json" };
import launchSting from "../../../templates/launch_sting/template.json" with { type: "json" };
import portfolioPulse from "../../../templates/portfolio_pulse/template.json" with { type: "json" };
import probe from "../../../templates/probe/template.json" with { type: "json" };

export interface TemplateMeta {
  id: string;
  version: string;
  status: string;
  styles: readonly string[];
  durations: readonly number[];
  /** Seconds per duration (null while awaiting design). */
  heroTime: Readonly<Record<string, number | null>>;
  aspects: Readonly<Record<string, { width: number; height: number }>>;
}

const RENDERABLE = new Set(["reference", "production"]);

export const TEMPLATES: Readonly<Record<string, TemplateMeta>> = Object.fromEntries(
  [chartMoment, countdown, kineticPost, launchSting, portfolioPulse, probe].map((t) => [t.id, t as TemplateMeta]),
);

export const isRenderable = (t: TemplateMeta | undefined): boolean =>
  t !== undefined && RENDERABLE.has(t.status) && t.styles.length > 0;

/**
 * Palette presets the builder has designed in templates/_kit/palettes.json. A null preset is "not designed yet":
 * the worker would silently render the template's own colours, so quotes refuse it instead (quotes/policy.ts).
 */
export const DESIGNED_PALETTES: ReadonlySet<string> = new Set(
  Object.entries(palettes as Record<string, unknown>)
    .filter(([name, v]) => !name.startsWith("//") && v !== null && typeof v === "object")
    .map(([name]) => name),
);
