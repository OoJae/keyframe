// Links from Keyframe's backend (watch page, receipt, review page, motion preview, ...), printed in tool text. Only
// the URL comes from the backend, and only when it passes the same own-host guard as the preview still (keyframeUrl);
// every label is fixed here, so a backend cannot add words to the agent's text. Unknown kinds are ignored.

import type { Config } from "./config.js";
import { keyframeUrl } from "./still.js";
import { quoted } from "./text.js";

export const LINK_LABELS = {
  watch: "Watch & download",
  download: "Download",
  receipt: "Receipt",
  review: "Review page",
  preview: "Motion preview (watermarked)",
  samples: "Samples",
  order: "Order page",
} as const;

export type LinkKind = keyof typeof LINK_LABELS;
export type Link = { kind: LinkKind; url: string };

/** At most this many link lines per tool result. */
export const MAX_LINK_LINES = 3;
/** Fixed record fields read before `links[]`, and how many `links[]` entries are read at all. */
const FIELDS: [string, LinkKind][] = [
  ["watch_url", "watch"],
  ["receipt_url", "receipt"],
  ["review_url", "review"],
];
const MAX_ENTRIES = 16;

const isKind = (k: unknown): k is LinkKind => typeof k === "string" && Object.hasOwn(LINK_LABELS, k);

/**
 * Valid links from backend records (an order, a quote, a paid response), in order: watch_url, receipt_url,
 * review_url, then links[] of {kind, url}. One per kind and per URL (the first wins); anything off Keyframe's own
 * hosts, not https, with control characters or over 600 characters is dropped.
 */
export function linksOf(cfg: Config, ...records: unknown[]): Link[] {
  const out: Link[] = [];
  const add = (kind: unknown, url: unknown) => {
    if (!isKind(kind) || typeof url !== "string") return;
    const ok = keyframeUrl(cfg, url);
    if (ok === null || out.some((l) => l.kind === kind || l.url === ok)) return;
    out.push({ kind, url: ok });
  };
  for (const rec of records) {
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) continue;
    const o = rec as Record<string, unknown>;
    for (const [field, kind] of FIELDS) add(kind, o[field]);
    if (!Array.isArray(o.links)) continue;
    for (const entry of o.links.slice(0, MAX_ENTRIES)) {
      const l = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      add(l.kind, l.url);
    }
  }
  return out;
}

/** One link as a text line: plugin-fixed label, the URL quoted as data. */
export const linkLine = (l: Link, label: string = LINK_LABELS[l.kind]): string => `${label}: ${quoted(l.url, 600)}`;

/** Up to 3 link lines from backend records (see linksOf). */
export const linkLines = (cfg: Config, ...records: unknown[]): string[] =>
  linksOf(cfg, ...records)
    .slice(0, MAX_LINK_LINES)
    .map((l) => linkLine(l));
