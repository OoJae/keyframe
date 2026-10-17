import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const PROTOCOL_VERSION = "2026-07-28";

function createServer() {
  const server = new McpServer(
    { name: "my-plugin", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "echo",
    {
      title: "Echo message",
      description: "Returns the provided message.",
      inputSchema: z.object({ message: z.string().min(1).max(256) }).strict(),
      outputSchema: z.object({ message: z.string() }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
      structuredContent: { message },
    }),
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
