// In-process harness: tool handlers run with fetch() routed to a World and KEYFRAME_* env set per test.

import { vi } from "vitest";
import { DEFAULTS } from "../../src/core/config.js";
import type { ToolResult } from "../../src/core/result.js";
import type { ToolDef } from "../../src/tools/define.js";
import { testEnv, World, worldFetch } from "./world.js";

export function setup(env: Record<string, string> = {}): World {
  const world = new World();
  vi.stubGlobal("fetch", worldFetch(world));
  for (const name of Object.keys(DEFAULTS)) vi.stubEnv(name, "");
  for (const [k, v] of Object.entries(testEnv(env))) vi.stubEnv(k, v);
  return world;
}

export type Called = ToolResult & { text: string; ms: number };

/** Loose JSON for assertions on structuredContent (validated against the tool's own schema by call()). */
// biome-ignore lint/suspicious/noExplicitAny: assertions over arbitrary tool JSON
export type Json = any;

/** Validates input like the MCP server does, runs the handler, and validates structuredContent on success. */
export async function call(tool: ToolDef, raw: unknown): Promise<Called> {
  const parsed = tool.inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`input rejected: ${parsed.error.message}`);
  const t0 = Date.now();
  const res = await tool.handler(parsed.data);
  const ms = Date.now() - t0;
  if (!res.isError) tool.outputSchema.parse(res.structuredContent);
  return { ...res, text: res.content.map((c) => c.text).join("\n"), ms };
}

export const PROPOSAL = "io.paybox/transactionProposal";

export const stingInput = (buyer: string, extra: Record<string, unknown> = {}) => ({
  buyer,
  format: "launch_sting",
  aspect: "9:16",
  rights_confirmed: true,
  params: { style: "instrument", wordmark: "Ripcord", tagline: "Agents decide. Ripcord lands the rescue." },
  ...extra,
});
