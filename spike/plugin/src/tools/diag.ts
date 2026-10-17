// Diagnostic tools for spike S1/S7: sandbox capabilities, fetch sizes/latency, and paid-body integrity.

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { apiBaseSource, resolveApiBase } from "../config.js";
import { Budget, boundedFetch, classify } from "../net.js";

// ------------------------------------------------------------------ diag_env (offline; conformance sample)

const envOutput = z.object({
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  crypto_subtle: z.string(),
  crypto_get_random_values: z.string(),
  abort_signal_timeout: z.string(),
  fetch: z.string(),
  keyframe_env_names: z.array(z.string()),
  api_base_source: z.enum(["env", "default", "env_invalid"]),
}).strict();

// ------------------------------------------------------------------ diag_fetch

const fetchResult = z.object({
  name: z.string(),
  host: z.string(),
  status: z.number().int().nullable(),
  ok: z.boolean(),
  ms: z.number().int(),
  bytes: z.number().int().optional(),
  expected_bytes: z.number().int().optional(),
  pattern_ok: z.boolean().optional(),
  chain_id_ok: z.boolean().optional(),
  error: z.string().optional(),
  cause_code: z.string().optional(),
}).strict();

const fetchOutput = z.object({
  api_base_source: z.enum(["env", "default"]),
  budget_ms: z.number().int(),
  total_ms: z.number().int(),
  results: z.array(fetchResult),
}).strict();

type FetchResult = z.infer<typeof fetchResult>;

const MB = 1024 * 1024;
const RPCS = [
  { name: "rpc_base_public", url: "https://mainnet.base.org" },
  // Alchemy key is injected by PayBox as a brokered Authorization header for this host; we send a plain request.
  { name: "rpc_alchemy_brokered", url: "https://base-mainnet.g.alchemy.com/v2" },
] as const;

async function rpcChainId(name: string, url: string, budget: Budget): Promise<FetchResult> {
  const host = new URL(url).hostname;
  const t0 = Date.now();
  try {
    const res = await boundedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    }, budget);
    let chainIdOk = false;
    try {
      const json = (await res.json()) as { result?: unknown };
      chainIdOk = json?.result === "0x2105";
    } catch {
      chainIdOk = false;
    }
    return { name, host, status: res.status, ok: res.ok && chainIdOk, ms: Date.now() - t0, chain_id_ok: chainIdOk };
  } catch (error) {
    const e = classify(error);
    return { name, host, status: null, ok: false, ms: Date.now() - t0, error: e.kind, ...(e.cause_code ? { cause_code: e.cause_code } : {}) };
  }
}

async function blob(base: string, sizeMb: number, budget: Budget): Promise<FetchResult> {
  const expected = sizeMb * MB;
  const url = `${base}/v1/diag/blob?bytes=${expected}`;
  const host = new URL(url).hostname;
  const name = `blob_${sizeMb}mb`;
  const t0 = Date.now();
  let bytes = 0;
  let patternOk = true;
  let status: number | null = null;
  try {
    const res = await boundedFetch(url, { method: "GET", headers: { accept: "application/octet-stream" } }, budget);
    status = res.status;
    if (!res.ok || !res.body) return { name, host, status, ok: false, ms: Date.now() - t0, bytes, expected_bytes: expected, error: "bad_response" };
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let j = 0; j < value.byteLength; j++) {
        if (value[j] !== (bytes + j) % 251) {
          patternOk = false;
          break;
        }
      }
      bytes += value.byteLength;
      if (bytes > expected) break;
    }
    return { name, host, status, ok: bytes === expected && patternOk, ms: Date.now() - t0, bytes, expected_bytes: expected, pattern_ok: patternOk };
  } catch (error) {
    const e = classify(error);
    return { name, host, status, ok: false, ms: Date.now() - t0, bytes, expected_bytes: expected, pattern_ok: patternOk, error: e.kind, ...(e.cause_code ? { cause_code: e.cause_code } : {}) };
  }
}

// ------------------------------------------------------------------ diag_paid_echo

const echoOutput = z.object({
  sha256: z.string(),
  canonical_bytes: z.number().int(),
  top_level_keys: z.array(z.string()),
  string_fields_over_64: z.array(z.object({ path: z.string(), length: z.number().int() }).strict()),
  paid_body: z.object({
    found_at: z.string(),
    order_id: z.string().nullable(),
    quote_id: z.string().nullable(),
    checksum_present: z.boolean(),
    checksum_matches: z.boolean().nullable(),
    k_buyer_test_length: z.number().int().nullable(),
  }).strict().nullable(),
}).strict();

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function longStrings(value: unknown, path: string, out: { path: string; length: number }[], depth = 0): void {
  if (out.length >= 50 || depth > 12) return;
  if (typeof value === "string") {
    if (value.length > 64) out.push({ path: path || "$", length: value.length });
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => longStrings(v, `${path}[${i}]`, out, depth + 1));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) longStrings(v, path ? `${path}.${k}` : k, out, depth + 1);
  }
}

/** Finds the Keyframe paid body (an object with order_id + quote_id), also inside JSON strings. */
function findPaidBody(value: unknown, path: string, depth = 0): { at: string; body: Record<string, unknown> } | null {
  if (depth > 8) return null;
  if (typeof value === "string" && value.length < 262_144 && value.trimStart().startsWith("{")) {
    try {
      return findPaidBody(JSON.parse(value), `${path}<json>`, depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.order_id === "string" && typeof obj.quote_id === "string") return { at: path || "$", body: obj };
  for (const [k, v] of Object.entries(obj)) {
    const hit = findPaidBody(v, path ? `${path}.${k}` : k, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------ registration

export function registerDiagTools(server: McpServer): void {
  server.registerTool(
    "diag_env",
    {
      title: "Keyframe spike: sandbox environment",
      description: "Offline diagnostic. Reports the Node version and platform, whether WebCrypto (crypto.subtle) and AbortSignal.timeout exist, and the NAMES (never values) of KEYFRAME_* environment variables. Makes no network calls.",
      inputSchema: z.object({}).strict(),
      outputSchema: envOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const names = Object.keys(process.env).filter((k) => k.startsWith("KEYFRAME_")).sort();
      const out: z.infer<typeof envOutput> = {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        crypto_subtle: typeof globalThis.crypto?.subtle,
        crypto_get_random_values: typeof globalThis.crypto?.getRandomValues,
        abort_signal_timeout: typeof AbortSignal.timeout,
        fetch: typeof globalThis.fetch,
        keyframe_env_names: names,
        api_base_source: apiBaseSource(),
      };
      return {
        content: [{ type: "text", text: `Node ${out.node} on ${out.platform}/${out.arch}; crypto.subtle: ${out.crypto_subtle}; AbortSignal.timeout: ${out.abort_signal_timeout}; KEYFRAME_* names: ${names.length ? names.join(", ") : "(none)"}; API base from: ${out.api_base_source}.` }],
        structuredContent: out,
      };
    },
  );

  server.registerTool(
    "diag_fetch",
    {
      title: "Keyframe spike: fetch sizes and RPC reachability",
      description: "Network diagnostic. Times eth_chainId on mainnet.base.org and on base-mainnet.g.alchemy.com (key supplied by PayBox as a brokered header), then GETs 1, 5 and 10 MB test blobs from the Keyframe spike API. Reports status, latency and byte counts only. Bounded: 4 s per request, under 9 s in total.",
      inputSchema: z.object({
        sizes_mb: z.array(z.union([z.literal(1), z.literal(5), z.literal(10)])).min(1).max(3).optional(),
      }).strict(),
      outputSchema: fetchOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ sizes_mb }) => {
      const budget = new Budget(8_500);
      const { base, source } = resolveApiBase();
      const results: FetchResult[] = await Promise.all(RPCS.map((r) => rpcChainId(r.name, r.url, budget)));
      for (const size of sizes_mb ?? [1, 5, 10]) {
        if (budget.slot() === 0) {
          results.push({ name: `blob_${size}mb`, host: new URL(base).hostname, status: null, ok: false, ms: 0, expected_bytes: size * MB, error: "skipped_budget" });
          continue;
        }
        results.push(await blob(base, size, budget));
      }
      const out = { api_base_source: source, budget_ms: 8_500, total_ms: budget.elapsed(), results };
      const summary = results.map((r) => `${r.name}: ${r.status ?? r.error} in ${r.ms} ms${r.bytes !== undefined ? ` (${r.bytes}/${r.expected_bytes} B)` : ""}`).join("; ");
      return { content: [{ type: "text", text: `${summary}. Total ${out.total_ms} ms.` }], structuredContent: out };
    },
  );

  server.registerTool(
    "diag_paid_echo",
    {
      title: "Keyframe spike: paid response integrity",
      description: "Pass the paid response you received from PayBox get_request (the whole object, or just the service body) as paid_response. Returns the canonical-JSON sha256, top-level keys, any string fields longer than 64 characters, and, when a Keyframe paid body is found, whether its checksum field still matches. No network calls.",
      inputSchema: z.object({ paid_response: z.record(z.string(), z.unknown()) }).strict(),
      outputSchema: echoOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ paid_response }) => {
      const canonical = canonicalJson(paid_response);
      const long: { path: string; length: number }[] = [];
      longStrings(paid_response, "", long);
      const found = findPaidBody(paid_response, "");
      let paidBody: z.infer<typeof echoOutput>["paid_body"] = null;
      if (found) {
        const { checksum, ...rest } = found.body;
        const s7 = rest.s7 as { k_buyer_test?: unknown } | undefined;
        paidBody = {
          found_at: found.at,
          order_id: typeof rest.order_id === "string" ? rest.order_id : null,
          quote_id: typeof rest.quote_id === "string" ? rest.quote_id : null,
          checksum_present: typeof checksum === "string",
          checksum_matches: typeof checksum === "string" ? sha256(canonicalJson(rest)) === checksum : null,
          k_buyer_test_length: typeof s7?.k_buyer_test === "string" ? s7.k_buyer_test.length : null,
        };
      }
      const out = {
        sha256: sha256(canonical),
        canonical_bytes: Buffer.byteLength(canonical, "utf8"),
        top_level_keys: Object.keys(paid_response).sort(),
        string_fields_over_64: long,
        paid_body: paidBody,
      };
      const verdict = paidBody ? `paid body at ${paidBody.found_at}: checksum ${paidBody.checksum_matches === null ? "absent" : paidBody.checksum_matches ? "MATCHES" : "DOES NOT MATCH"}` : "no Keyframe paid body found";
      return { content: [{ type: "text", text: `canonical sha256 ${out.sha256} (${out.canonical_bytes} B); ${verdict}.` }], structuredContent: out };
    },
  );
}
