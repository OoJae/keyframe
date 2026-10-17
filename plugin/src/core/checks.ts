// The plugin's own check results (strict, unlike backend data). "fail" blocks any proposal; "warn" and "skip" are
// reported but do not block; a verdict is "verified" only when nothing failed or was skipped.

import { clean } from "./text.js";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export type Check = { id: string; status: CheckStatus; detail: string };
export type Verdict = "verified" | "partial" | "failed";

const mk =
  (status: CheckStatus) =>
  (id: string, detail: string): Check => ({ id, status, detail: clean(detail, 400) });

export const pass = mk("pass");
export const fail = mk("fail");
export const warn = mk("warn");
export const skip = mk("skip");

export const failed = (checks: readonly Check[]): Check[] => checks.filter((c) => c.status === "fail");

export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "failed";
  if (checks.some((c) => c.status === "skip")) return "partial";
  return "verified";
}

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗ FAILED", warn: "⚠", skip: "– skipped" };

/** "- id ✓ detail" lines for the text summary. */
export function checkLines(checks: readonly Check[]): string {
  return checks.map((c) => `- ${c.id} ${MARK[c.status]}: ${c.detail}`).join("\n");
}
