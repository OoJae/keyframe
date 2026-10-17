import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
export const VECTOR_INPUT = path.join(REPO_ROOT, "docs/design/vectors/terms-v1.input.json");
export const VECTOR_OUTPUT = path.join(PKG_ROOT, "test/vectors/terms-v1.output.json");
export const FIXTURES = path.join(PKG_ROOT, "test/fixtures");

/** The shared KFC1 vector plaintext: byte i = i mod 251. */
export function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out;
}

export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
