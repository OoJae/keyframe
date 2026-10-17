// The frozen surface itself: starter tooling byte-identical, vendored protocol in sync, schemas representable and
// within limits, the catalog snapshot current, copy rules respected, and no secrets in the bundle (P1, P2, P12).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools/index.js";
import { call, type Json, setup } from "./harness/inproc.js";
import { HOSTS } from "./harness/world.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const jsonSchema = (s: unknown, io: "input" | "output") =>
  (s as { "~standard": { jsonSchema: Record<"input" | "output", (o: object) => Record<string, unknown>> } })[
    "~standard"
  ].jsonSchema[io]({
    target: "draft-2020-12",
  });

describe("starter v1.0.2 tooling", () => {
  const manifest = JSON.parse(read(".starter-manifest.json").toString());
  it.each([
    "scripts/conformance.mjs",
    "scripts/test.mjs",
    "scripts/process.mjs",
    "scripts/report.mjs",
    "scripts/schema.mjs",
    "tsconfig.json",
    "pnpm-workspace.yaml",
    "src/paybox.ts",
    "starter-version.json",
    ".gitignore",
  ])("%s is byte-identical to the starter", (f) => expect(sha(read(f))).toBe(manifest.files[f]));

  it("package.json keeps the starter scripts and pins every dependency exactly", () => {
    const pkg = JSON.parse(read("package.json").toString());
    expect(pkg.scripts).toMatchObject({
      dev: "tsx src/plugin.ts",
      build:
        "esbuild src/plugin.ts --bundle --platform=node --format=esm --target=node24 --minify --outfile=dist/plugin.mjs",
      conformance: "node scripts/conformance.mjs",
      test: "node scripts/test.mjs",
      typecheck: "tsc --noEmit",
    });
    for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies }))
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies).toEqual({ "@modelcontextprotocol/server": "2.0.0", viem: "2.51.3", zod: "4.4.3" });
  });

  it("src/protocol is the unedited generated copy of packages/protocol/src", () => {
    const out = execFileSync(process.execPath, [
      path.join(root, "../scripts/sync-protocol.mjs"),
      "--check",
      "--target",
      path.join(root, "src/protocol"),
    ]).toString();
    expect(out).toMatch(/matches packages\/protocol\/src/);
  });
});

describe("tool schemas", () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false });
  it.each(TOOLS.map((t) => [t.name, t]))("%s: object root, valid JSON Schema 2020-12, <= 64 KiB", (_n, tool) => {
    const input = jsonSchema(tool.inputSchema, "input");
    const output = jsonSchema(tool.outputSchema, "output");
    expect(input.type).toBe("object");
    expect(() => ajv.compile(input)).not.toThrow();
    expect(() => ajv.compile(output)).not.toThrow();
    expect(JSON.stringify(input).length + JSON.stringify(output).length).toBeLessThan(64 * 1024);
    expect(JSON.stringify(input)).not.toContain("x-mcp-header");
  });

  it("keyframe_quote params is an anyOf of strict per-format objects (incl. catalog)", () => {
    const quote = TOOLS.find((t) => t.name === "keyframe_quote");
    const params = (jsonSchema(quote?.inputSchema, "input").properties as Record<string, Json>).params;
    expect(params.anyOf).toHaveLength(7);
    for (const v of params.anyOf) expect(v).toMatchObject({ type: "object", additionalProperties: false });
    expect(params.anyOf.some((v: Json) => "catalog_id" in v.properties)).toBe(true);
  });

  it("proposal tools declare only the starter's proposal key", () => {
    for (const name of ["keyframe_commission", "keyframe_commission_direct", "keyframe_refund"]) {
      const t = TOOLS.find((x) => x.name === name);
      const out = jsonSchema(t?.outputSchema, "output");
      expect(Object.keys(out.properties as object)).toEqual(["io.paybox/transactionProposal"]);
      expect(out.additionalProperties).toBe(false);
    }
  });
});

describe("tool copy", () => {
  it("numbered titles and factual descriptions, with the frozen wording rules", () => {
    const titles = Object.fromEntries(TOOLS.map((t) => [t.name, t.title]));
    expect(titles.keyframe_quote).toBe("Keyframe · 1. quote an order (free)");
    expect(titles.keyframe_commission).toBe("Keyframe · 2. pay into escrow (1 approval)");
    expect(titles.keyframe_status).toBe("Keyframe · 3. check an order (free)");
    expect(titles.keyframe_verify).toBe("Keyframe · 4. verify delivery independently (free)");
    for (const t of TOOLS) {
      expect(`${t.title} ${t.description}`).not.toMatch(
        /PayBox[- ]verified|\baudited\b|AI video generator|first ever/i,
      );
      expect(t.description.length).toBeLessThan(1_200);
    }
    const text = TOOLS.map((t) => t.description).join(" ");
    for (const core of ["get_request", "wallet_id", "request_wallet_sign", "list_credentials", "get_portfolio"])
      expect(text).toContain(core);
  });
});

describe("catalog freeze gate (P2)", () => {
  it("tool-catalog.json matches the built bundle", () => {
    const out = execFileSync(process.execPath, [path.join(root, "scripts/catalog-snapshot.mjs"), "--check"], {
      cwd: root,
    }).toString();
    expect(out).toMatch(/matches dist\/plugin\.mjs \(9 tools/);
  });
});

describe("secret hygiene (P12)", () => {
  it("the bundle contains no keys, bearer tokens or private-key material", () => {
    const bundle = read("dist/plugin.mjs").toString();
    expect(bundle).not.toMatch(/alchemy|PRIVATE_KEY|DEPLOYER|ETHERSCAN|Bearer [A-Za-z0-9]|KMASTER\s*=|-----BEGIN/i);
    expect(bundle).not.toMatch(/\b[0-9a-f]{64}\b(?=.*private)/i);
    expect(bundle).not.toContain("kf.test");
  });

  it("outputs never echo env values (RPC URL path secrets, hosts) even on failures", async () => {
    const world = setup();
    world.down.add("rpc1.kf.test");
    world.delays.set("rpc2.kf.test", 5_000);
    const outputs = await Promise.all(
      TOOLS.filter((t) => ["keyframe_verify", "keyframe_status", "keyframe_refund"].includes(t.name)).map((t) =>
        call(
          t,
          t.name === "keyframe_verify"
            ? { mode: "funding", terms_hash: `0x${"12".repeat(32)}` }
            : t.name === "keyframe_status"
              ? { order_id: "o_1111111111111111111111" }
              : { action: "refund", quote_id: "q_1111111111111111111111" },
        ),
      ),
    );
    const all = JSON.stringify(outputs);
    expect(all).not.toContain("KF-SECRET-MARKER");
    expect(all).not.toContain(new URL(HOSTS.rpc2).host);
    expect(all).not.toContain(new URL(HOSTS.rpc1).host);
  });
});
