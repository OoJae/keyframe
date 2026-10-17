import type { Hex } from "viem";
import { bufferSource, toHex, utf8 } from "./bytes.js";

// RFC 8785 JSON Canonicalization Scheme, restricted to the Keyframe profile (§6): strings, booleans, null,
// safe integers, arrays and plain objects. Floats, NaN/Infinity, unsafe integers, bigint, lone surrogates,
// cycles and non-plain objects throw instead of being silently coerced.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class JcsError extends Error {
  override name = "JcsError";
}

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new JcsError("JCS: lone surrogate in string");
  // ECMAScript JSON.stringify emits exactly the RFC 8785 §3.2.2.2 escapes for well-formed strings.
  return JSON.stringify(s);
}

function serialize(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return serializeString(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new JcsError(`JCS: ${path} is not a safe integer (${String(value)})`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object":
      break;
    default:
      throw new JcsError(`JCS: ${path} has unsupported type ${typeof value}`);
  }

  const obj = value as object;
  if (stack.has(obj)) throw new JcsError(`JCS: ${path} is cyclic`);
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        const item: unknown = obj[i];
        if (item === undefined) throw new JcsError(`JCS: ${path}[${i}] is undefined`);
        items.push(serialize(item, `${path}[${i}]`, stack));
      }
      return `[${items.join(",")}]`;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new JcsError(`JCS: ${path} is not a plain object`);
    const rec = obj as Record<string, unknown>;
    // Members whose value is undefined are omitted, exactly like JSON.stringify, so an object hashes the same
    // before and after a JSON round trip. Default sort = UTF-16 code unit order (RFC 8785 §3.2.3).
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    const members = keys.map((k) => `${serializeString(k)}:${serialize(rec[k], `${path}.${k}`, stack)}`);
    return `{${members.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** RFC 8785 canonical JSON text (integers only). Throws JcsError on anything outside the profile. */
export function jcs(value: unknown): string {
  if (value === undefined) throw new JcsError("JCS: value is undefined");
  return serialize(value, "$", new Set());
}

/** Lowercase 0x-hex SHA-256 of bytes, or of the UTF-8 encoding of a string (WebCrypto). */
export async function sha256Hex(data: Uint8Array | string): Promise<Hex> {
  const bytes = typeof data === "string" ? utf8(data) : bufferSource(data);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** specHash = sha256(JCS(spec)) (§6). Hashes exactly what it is given; validate with SpecSchema separately. */
export async function specHash(spec: unknown): Promise<Hex> {
  return sha256Hex(jcs(spec));
}
