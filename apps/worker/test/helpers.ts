import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { after } from "node:test";
import { DEFAULT_TEMPLATES_DIR } from "../src/config.ts";
import { createLogger } from "../src/log.ts";

export const TEMPLATES = DEFAULT_TEMPLATES_DIR;

/** A temp dir removed after the current test file. */
export async function tempDir(prefix = "kfw-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A pino logger whose output is captured as text (for "no secrets in logs" assertions). */
export function captureLogger(level = "debug") {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { log: createLogger(level, sink), text: () => lines.join("") };
}

/** Unescape the five entities stampHtml/escapeAttr produce. */
export function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
