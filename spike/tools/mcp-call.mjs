// Minimal MCP stdio harness for a built PayBox plugin bundle (same wire format as the starter's conformance runner:
// MCP 2026-07-28, one fresh process per operation). Lists tools, calls one, validates the arguments and the
// structuredContent against the tool's declared schemas with the starter's own validator, and prints the result.
//
//   node mcp-call.mjs <path/to/plugin.mjs> <tool> '<json arguments>' [--map https://host=http://127.0.0.1:8787]
//
// Only KEYFRAME_* variables (plus PATH/HOME) are passed to the plugin process, like a hosted sandbox with configured
// variables. --map loads fetch-map-preload.mjs (test-only https->localhost mapping).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { validateSample } = await import(pathToFileURL(resolve(here, "../plugin/scripts/schema.mjs")).href);

const [artifact, tool, argsJson = "{}", ...rest] = process.argv.slice(2);
if (!artifact || !tool) {
  console.error("usage: node mcp-call.mjs <plugin.mjs> <tool> '<json args>' [--map https://host=http://127.0.0.1:port]");
  process.exit(2);
}
const mapIdx = rest.indexOf("--map");
const map = mapIdx >= 0 ? rest[mapIdx + 1] : undefined;
const args = JSON.parse(argsJson);

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "production", NO_COLOR: "1" };
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("KEYFRAME_") && v !== undefined) env[k] = v;
const nodeArgs = [];
if (map) {
  env.SPIKE_FETCH_MAP = map;
  nodeArgs.push("--import", pathToFileURL(resolve(here, "fetch-map-preload.mjs")).href);
}

function operation(method, params, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, resolve(artifact)], { env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`operation exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== 2) return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolvePromise(msg);
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`plugin exited without a response${stderr ? ` (stderr: ${stderr.slice(0, 300)})` : ""}`));
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 2, method,
      params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "keyframe-spike-harness", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    })}\n`);
  });
}

const started = Date.now();
const list = await operation("tools/list", {});
const selected = list.result.tools.find((t) => t.name === tool);
if (!selected) {
  console.error(`tool ${tool} not found; available: ${list.result.tools.map((t) => t.name).join(", ")}`);
  process.exit(1);
}
const t0 = Date.now();
const call = await operation("tools/call", { name: tool, arguments: args });
const callMs = Date.now() - t0;
let schema = "skipped (isError)";
if ("error" in call) schema = "json-rpc error";
else if (call.result.isError !== true) {
  validateSample(selected, args, call.result);
  schema = "structuredContent matches outputSchema";
}
console.log(JSON.stringify({ tool, call_ms: callMs, total_ms: Date.now() - started, schema_check: schema, result: call.result ?? call.error }, null, 2));
