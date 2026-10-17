// Stdio harness for the built bundle: serves a World over local HTTP and talks to dist/plugin.mjs the way the
// starter conformance runner and the PayBox sandbox do (one fresh process per operation, MCP 2026-07-28 _meta,
// minimal env plus KEYFRAME_* variables).

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testEnv, type World } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = path.resolve(here, "../../dist/plugin.mjs");
const PRELOAD = pathToFileURL(path.join(here, "fetch-map.mjs")).href;

export async function serve(world: World): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const host = String(req.headers["x-kf-host"] ?? "unknown.kf.test");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host") headers.set(k, v);
    const request = new Request(`https://${host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const out = await world.handle(request);
    const body = Buffer.from(await out.arrayBuffer());
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

import type { Json } from "./inproc.js";

export type Op = { message: Record<string, Json>; stdoutBytes: number; ms: number };

export async function mcp(
  method: string,
  params: Record<string, unknown>,
  opts: { target: string; env?: Record<string, string> },
): Promise<Op> {
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    KF_TEST_FETCH_TARGET: opts.target,
    ...testEnv(opts.env),
  };
  const child = spawn(process.execPath, ["--import", PRELOAD, ARTIFACT], { env, stdio: ["pipe", "pipe", "pipe"] });
  const t0 = Date.now();
  let stdoutBytes = 0;
  child.stdout.on("data", (d: Buffer) => {
    stdoutBytes += d.byteLength;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "keyframe-harness", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );
    for await (const line of lines) {
      const message = JSON.parse(line) as Record<string, Json>;
      if (message.id === 2) return { message, stdoutBytes, ms: Date.now() - t0 };
    }
    throw new Error("plugin exited without a response");
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill("SIGKILL");
  }
}

type Validate = (tool: unknown, args: unknown, result?: unknown) => void;
/** The starter's own validator (scripts/schema.mjs, Ajv 2020): sample args + structuredContent vs declared schemas. */
export async function starterValidator(): Promise<Validate> {
  const href = pathToFileURL(path.resolve(here, "../../scripts/schema.mjs")).href;
  return ((await import(href)) as { validateSample: Validate }).validateSample;
}
