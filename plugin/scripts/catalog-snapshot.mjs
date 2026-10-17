#!/usr/bin/env node
// Snapshots the bundle's MCP tool catalog (names, titles, descriptions, annotations, input/output JSON Schemas) to
// tool-catalog.json, the freeze diff gate for frozen-interfaces.md §8. Talks to dist/plugin.mjs exactly like the
// starter's conformance runner (one fresh process per operation, MCP 2026-07-28 request _meta, minimal env), using
// the starter's own bounded process helper. Deterministic output: no timestamps, tools in discovery order.
//
//   node scripts/catalog-snapshot.mjs           # write tool-catalog.json
//   node scripts/catalog-snapshot.mjs --check   # exit 1 if tool-catalog.json differs from the bundle

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { withProcess } from "./process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(root, "dist/plugin.mjs");
const target = resolve(root, "tool-catalog.json");
const release = JSON.parse(await readFile(resolve(root, "starter-version.json"), "utf8"));

async function operation(method, params) {
  const home = await mkdtemp(resolve(tmpdir(), "keyframe-catalog-"));
  try {
    return await withProcess(
      process.execPath,
      [artifact],
      {
        cwd: dirname(artifact),
        env: { HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      async (child) => {
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": release.protocolVersion,
                "io.modelcontextprotocol/clientInfo": { name: "keyframe-catalog-snapshot", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          })}\n`,
        );
        try {
          for await (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.id === 2) return msg;
          }
          throw new Error("plugin exited without a response");
        } finally {
          lines.close();
        }
      },
      10_000,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function snapshot() {
  const tools = [];
  let cursor;
  for (let page = 0; page < 16; page++) {
    const res = await operation("tools/list", cursor === undefined ? {} : { cursor });
    if (!res.result || !Array.isArray(res.result.tools)) throw new Error("tools/list failed");
    for (const t of res.result.tools) {
      tools.push({
        name: t.name,
        title: t.title,
        description: t.description,
        annotations: t.annotations,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      });
    }
    cursor = res.result.nextCursor;
    if (cursor == null) break;
  }
  const body = JSON.stringify(tools);
  return {
    catalogVersion: 1,
    plugin: "keyframe",
    frozenInterfaces: "v1",
    protocolVersion: release.protocolVersion,
    toolCount: tools.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    tools,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const text = `${JSON.stringify(await snapshot(), null, 2)}\n`;
  if (check) {
    const current = await readFile(target, "utf8").catch(() => "");
    if (current !== text) {
      console.error(
        "tool-catalog.json differs from dist/plugin.mjs (the frozen tool surface changed). Run: node scripts/catalog-snapshot.mjs",
      );
      process.exit(1);
    }
    console.log(
      `tool-catalog.json matches dist/plugin.mjs (${JSON.parse(text).toolCount} tools, sha256 ${JSON.parse(text).sha256})`,
    );
  } else {
    await writeFile(target, text);
    console.log(`wrote tool-catalog.json (${JSON.parse(text).toolCount} tools, sha256 ${JSON.parse(text).sha256})`);
  }
}
