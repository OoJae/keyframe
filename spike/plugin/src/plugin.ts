import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { registerCommissionTools } from "./tools/commission.js";
import { registerDiagTools } from "./tools/diag.js";

const PROTOCOL_VERSION = "2026-07-28";

// Keyframe DAY-1 interop spike plugin. No network or env access happens at module load or discovery;
// every tool reads configuration and talks to the network only inside its own handler.
function createServer() {
  const server = new McpServer(
    { name: "keyframe-spike", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );
  registerDiagTools(server);
  registerCommissionTools(server);
  return server;
}

serveStdio(createServer, { legacy: "reject" });
