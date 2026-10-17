import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { commissionDirectTool, commissionTool } from "./tools/commission.js";
import { registerTool } from "./tools/define.js";
import { ordersTool } from "./tools/orders.js";
import { quoteTool } from "./tools/quote.js";
import { refundTool } from "./tools/refund.js";
import { reviewTool } from "./tools/review.js";
import { statusTool } from "./tools/status.js";
import { stylesTool } from "./tools/styles.js";
import { verifyTool } from "./tools/verify.js";

const PROTOCOL_VERSION = "2026-07-28";

// Keyframe: hire a motion designer from chat, pay only on delivery. Module load and discovery only register
// tools: no network, no env reads, no side effects (each handler reads config and talks to the network itself).
function createServer() {
  const server = new McpServer(
    { name: "keyframe", version: "1.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );
  registerTool(server, stylesTool);
  registerTool(server, quoteTool);
  registerTool(server, commissionTool);
  registerTool(server, commissionDirectTool);
  registerTool(server, statusTool);
  registerTool(server, verifyTool);
  registerTool(server, refundTool);
  registerTool(server, reviewTool);
  registerTool(server, ordersTool);
  return server;
}

serveStdio(createServer, { legacy: "reject" });
