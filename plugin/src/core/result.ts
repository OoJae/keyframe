// Tool result helpers. A ToolError carries a message written for the user and agent; anything else thrown inside a
// handler becomes a generic message (no stack, no URLs, no env values). Errors never carry a proposal. A data result
// is capped as a whole (the sandbox drops stdout lines above 256 KiB), whatever the backend sent.

import { utf8Bytes } from "./text.js";

export type TextContent = { type: "text"; text: string };
export type ToolResult = {
  [key: string]: unknown;
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export class ToolError extends Error {
  override name = "ToolError";
}

const MAX_TEXT = 6_000;
/** Whole serialized data result (text + structuredContent), well under the 256 KiB stdout line limit. */
export const MAX_RESULT_BYTES = 200 * 1024;

const cap = (text: string): string => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`);

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text: cap(text) }], isError: true };
}

export function dataResult(text: string, structured: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: cap(text) }], structuredContent: structured };
  if (utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) {
    return errorResult(
      "This result would be larger than the 200 KiB this plugin relays, because Keyframe's server sent an oversized record; nothing was relayed. No money moved.",
    );
  }
  return result;
}

export async function guarded(run: () => Promise<ToolResult>, nothingMoved: string): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error.message);
    return errorResult(`Keyframe hit an unexpected internal error. ${nothingMoved}`);
  }
}

export const NOTHING_PROPOSED = "Nothing was proposed and no money moved.";
export const NOTHING_MOVED = "No money moved.";
