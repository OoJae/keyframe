import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import type { ToolResult } from "../core/result.js";

export type Annotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type ToolDef<I extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: z.ZodType;
  annotations: Annotations;
  handler: (input: z.output<I>) => Promise<ToolResult>;
};

export const defineTool = <I extends z.ZodType>(def: ToolDef<I>): ToolDef<I> => def;

export function registerTool<I extends z.ZodType>(server: McpServer, def: ToolDef<I>): void {
  // The SDK validates `input` with inputSchema before calling the handler, so the cast is sound.
  const inputSchema: z.ZodType = def.inputSchema;
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations,
    },
    (input: unknown) => def.handler(input as z.output<I>),
  );
}
