import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PKG_ROOT } from "./helpers.js";

// src/ must bundle for Cloudflare Workers and the PayBox plugin sandbox: web platform APIs only.
// (tsconfig.src.json typechecks src without @types/node; this catches what types alone cannot.)
const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']node:/, "node: import"],
  [/\brequire\s*\(/, "require()"],
  [/\bBuffer\b/, "Buffer"],
  [/\bprocess\./, "process"],
  [/__dirname|__filename/, "CommonJS globals"],
  [/import\.meta\.(?!url)/, "import.meta"],
  [/from\s+["']\.{1,2}\/[^"']*(?<!\.js)["']/, "relative import without .js"],
  [/from\s+["'](?!viem["']|zod\/v4["']|\.)/, "dependency other than viem / zod"],
];

describe("src portability", () => {
  const dir = path.join(PKG_ROOT, "src");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it.each(files)("%s uses only web APIs, viem and zod", (f) => {
    const src = readFileSync(path.join(dir, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const [re, what] of FORBIDDEN) expect(re.test(src), `${f}: ${what}`).toBe(false);
  });
});
