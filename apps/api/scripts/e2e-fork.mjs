#!/usr/bin/env node
// Keyframe end to end on a local anvil fork of Base mainnet with real USDC (FiatTokenV2_2), driven through the BUILT
// plugin bundle over MCP stdio. Every component is the real one: contracts/script/Deploy.s.sol, the API bundle in
// workerd (`wrangler dev --local`: D1, KV, R2, the relayer Durable Object, the scheduled keeper), the render worker
// (HyperFrames + ffmpeg, `serve` mode) and plugin/dist/plugin.mjs, one fresh process per tool call like the PayBox
// sandbox. PayBox itself is emulated: the x402 proposal is paid with @x402/core + @x402/evm client code signing a
// real EIP-3009 authorization with the buyer key, and evm proposals are sent from the buyer key.
//
// Run through scripts/e2e-fork.sh (it loads ALCHEMY_API_KEY from .env and pins Node 24.21.0). Never touches mainnet:
// the only remote calls are anvil's read-only fork fetches. Keys and secrets are generated per run, kept out of every
// log (redacted) and out of tracked files; the secret env files in the run directory are deleted on exit.
//
//   FORK_URL=… E2E_RUN_DIR=… node apps/api/scripts/e2e-fork.mjs
import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseTransaction,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ------------------------------------------------------------------------------------------------ paths & config

const API_DIR = resolve(import.meta.dirname, "..");
const ROOT = resolve(API_DIR, "../..");
const CONTRACTS = join(ROOT, "contracts");
const WORKER_DIR = join(ROOT, "apps/worker");
const PLUGIN_DIR = join(ROOT, "plugin");
const PLUGIN_BUNDLE = join(PLUGIN_DIR, "dist/plugin.mjs");
const PRELOAD = pathToFileURL(join(import.meta.dirname, "e2e/plugin-preload.mjs")).href;
const WRANGLER = join(API_DIR, "node_modules/.bin/wrangler");

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
/** Morpho Blue on Base: one of the largest USDC holders (impersonated on the fork only). */
const USDC_HOLDER = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const FORK_URL = process.env.FORK_URL ?? "";
const FORK_BLOCK = Number(process.env.FORK_BLOCK ?? "52710000");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
const RUN_DIR = resolve(process.env.E2E_RUN_DIR ?? join(ROOT, ".e2e", STAMP));
const STATE = join(RUN_DIR, "wrangler-state");
const PROPOSAL = "io.paybox/transactionProposal";
const HOST = { api: "api.kf.test", files: "files.kf.test", rpcA: "rpc-a.kf.test", rpcB: "rpc-b.kf.test" };
const PUBLIC_BASE = `https://${HOST.api}`;
const FILES_BASE = `https://${HOST.files}`;
const BUYER_USDC = 60_000_000n;

if (!FORK_URL.startsWith("https://")) {
  console.error("FORK_URL (https Base RPC for anvil --fork-url) is required; run scripts/e2e-fork.sh");
  process.exit(2);
}
mkdirSync(RUN_DIR, { recursive: true });

// ------------------------------------------------------------------------------------------------ redaction & logs

const secrets = new Set();
const addSecret = (s) => {
  if (typeof s === "string" && s.length >= 8) {
    secrets.add(s);
    if (s.startsWith("0x")) secrets.add(s.slice(2));
  }
};
addSecret(FORK_URL);
addSecret(FORK_URL.split("/").pop());
addSecret(process.env.ALCHEMY_API_KEY);
const redact = (text) => {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join("<redacted>");
  return out;
};
const driverLog = createWriteStream(join(RUN_DIR, "driver.log"), { flags: "a" });
const log = (...parts) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p, big))).join(" "));
  console.log(line);
  driverLog.write(`${new Date().toISOString()} ${line}\n`);
};
function big(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

// ------------------------------------------------------------------------------------------------ report & steps

const report = {
  v: 1,
  run_id: STAMP,
  started_at: new Date().toISOString(),
  fork: { block: FORK_BLOCK, chain_id: null, block_timestamp: null },
  versions: { node: process.version },
  addresses: {},
  bundle: {},
  steps: [],
  txs: {},
  timings: {},
  observations: [],
};
const sec = (ms) => Math.round(ms) / 1000;
let currentScenario = "setup";
class CheckError extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new CheckError(msg);
};

async function step(id, name, fn) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "";
    report.steps.push({ scenario: currentScenario, id, name, status: "pass", ms: Date.now() - t0, detail });
    log(
      `PASS ${id} ${name}${detail ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail, big)})` : ""}`,
    );
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    report.steps.push({ scenario: currentScenario, id, name, status: "fail", ms: Date.now() - t0, detail });
    log(`FAIL ${id} ${name}  (${detail})`);
    if (!(e instanceof CheckError)) log(e?.stack ?? "");
    throw new ScenarioAbort(id);
  }
}
class ScenarioAbort extends Error {}

async function scenario(name, fn) {
  currentScenario = name;
  log(`\n===== ${name}`);
  try {
    await fn();
    return true;
  } catch (e) {
    if (!(e instanceof ScenarioAbort)) {
      report.steps.push({
        scenario: name,
        id: "-",
        name: "scenario crashed",
        status: "fail",
        ms: 0,
        detail: String(e),
      });
      log(`CRASH ${name}: ${e?.stack ?? e}`);
    }
    return false;
  }
}

const observe = (what) => {
  report.observations.push(redact(what));
  log(`NOTE ${what}`);
};

// ------------------------------------------------------------------------------------------------ processes

const children = [];
const tails = {};
function startProc(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(join(RUN_DIR, `${name}.log`), { flags: "a" });
  tails[name] = [];
  const onLine = (line) => {
    const l = redact(line);
    out.write(`${l}\n`);
    tails[name].push(l);
    if (tails[name].length > 20_000) tails[name].splice(0, 5_000);
  };
  createInterface({ input: p.stdout }).on("line", onLine);
  createInterface({ input: p.stderr }).on("line", onLine);
  const entry = { name, p, exited: false, code: null };
  p.on("exit", (code) => {
    entry.exited = true;
    entry.code = code;
  });
  children.push(entry);
  return entry;
}
function killGroup(entry, signal = "SIGTERM") {
  if (!entry || entry.exited) return;
  try {
    process.kill(-entry.p.pid, signal);
  } catch {
    try {
      entry.p.kill(signal);
    } catch {}
  }
}
async function stopProc(entry, ms = 15_000) {
  if (!entry || entry.exited) return;
  killGroup(entry, "SIGTERM");
  const until = Date.now() + ms;
  while (!entry.exited && Date.now() < until) await sleep(100);
  if (!entry.exited) killGroup(entry, "SIGKILL");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs, intervalMs = 250) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until)
      throw new CheckError(
        `timed out after ${timeoutMs} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`,
      );
    await sleep(intervalMs);
  }
}
async function freePort() {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
}
const secretFiles = [];
function writeSecretFile(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  secretFiles.push(path);
}

// ------------------------------------------------------------------------------------------------ chain helpers

let ANVIL = "";
let pub;
let factoryAbi;
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
async function rpc(method, params = []) {
  const r = await fetch(ANVIL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const usdcOf = (a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const chainNow = async () => Number((await pub.getBlock()).timestamp);
const STATUS = ["None", "Open", "Delivered", "Released", "Refunded", "Cancelled", "Rejected"];
let FACTORY;
let VAULT_IMPL;
const orderOf = async (termsHash) => {
  const o = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "order", args: [termsHash] });
  return { ...o, statusName: STATUS[o.status] };
};
const cloneCode = (impl) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
let KMASTER_HEX = "";
const kChainOf = (quoteId) =>
  `0x${createHmac("sha256", Buffer.from(KMASTER_HEX, "hex")).update(`kf/kchain/v1/${quoteId}`).digest("hex")}`;
const sha256hex = (b) => `0x${createHash("sha256").update(b).digest("hex")}`;

// ------------------------------------------------------------------------------------------------ https host map

let HOSTS = {};
/** The driver's own view of the https hosts (PayBox emulation): the same map the plugin preload uses. */
function httpsFetch(url, init) {
  const u = new URL(url);
  const target = HOSTS[u.hostname];
  if (u.protocol !== "https:" || !target) throw new Error(`unmapped host ${u.hostname}`);
  return fetch(`${target}${u.pathname}${u.search}`, init);
}

// ------------------------------------------------------------------------------------------------ plugin over MCP stdio

let pluginEnv = {};
let toolDefs = [];
let validateSample;
async function mcp(method, params, { clockOffsetMs = 0 } = {}) {
  const env = {
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    KF_E2E_HOSTS: JSON.stringify(HOSTS),
    KF_E2E_CLOCK_OFFSET_MS: String(clockOffsetMs),
    ...pluginEnv,
  };
  const child = spawn(process.execPath, ["--import", PRELOAD, PLUGIN_BUNDLE], { env, stdio: ["pipe", "pipe", "pipe"] });
  const t0 = Date.now();
  let stdoutBytes = 0;
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdoutBytes += d.byteLength;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
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
            "io.modelcontextprotocol/clientInfo": { name: "keyframe-e2e-fork", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.id === 2) return { message, stdoutBytes, ms: Date.now() - t0, stderr };
    }
    throw new Error(`plugin exited without a response${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill("SIGKILL");
  }
}

const pluginCalls = [];
/** One tools/call in a fresh process; results are validated with the starter's own validator (scripts/schema.mjs). */
/** Payment tools take {quote_id, buyer, terms_hash} (frozen §8 pre-upload revision): fill the deal from the API. */
async function withDeal(name, args) {
  if (!["keyframe_commission", "keyframe_commission_direct"].includes(name) || !args?.quote_id || args.terms_hash)
    return args;
  const q = await (await fetch(`${api}/v1/quotes/${args.quote_id}`)).json();
  return { quote_id: args.quote_id, buyer: args.buyer ?? q.buyer, terms_hash: q.terms_hash };
}

async function tool(name, argsIn, opts = {}) {
  const args = await withDeal(name, argsIn);
  const op = await mcp("tools/call", { name, arguments: args }, opts);
  const result = op.message.result;
  check(
    result && result.resultType === "complete",
    `${name}: no complete result (${JSON.stringify(op.message.error ?? op.message).slice(0, 300)})`,
  );
  const text = (result.content ?? []).map((c) => c.text).join("\n");
  const def = toolDefs.find((t) => t.name === name);
  if (!result.isError) validateSample(def, args, result);
  check(op.stdoutBytes < 64 * 1024, `${name}: stdout ${op.stdoutBytes} bytes (limit 64 KiB)`);
  check(op.ms < 9_500, `${name}: took ${op.ms} ms (sandbox budget 10 s)`);
  pluginCalls.push({ scenario: currentScenario, tool: name, ms: op.ms, isError: !!result.isError });
  writeFileSync(
    join(RUN_DIR, "plugin-calls.jsonl"),
    `${redact(JSON.stringify({ at: new Date().toISOString(), tool: name, args, ms: op.ms, result }))}\n`,
    { flag: "a" },
  );
  return { ...result, text, ms: op.ms, sc: result.structuredContent };
}
const failing = (checks = []) => checks.filter((c) => c.status === "fail");
const checkIds = (checks = [], status) => checks.filter((c) => c.status === status).map((c) => c.id);

// ------------------------------------------------------------------------------------------------ PayBox emulation

/** What PayBox does with an x402 proposal: probe without payment, check, sign EIP-3009, retry with PAYMENT-SIGNATURE. */
async function payX402(proposalContent, account) {
  const p = proposalContent[PROPOSAL];
  check(p?.kind === "x402" && p.chain === "eip155:8453", "proposal is not an x402 proposal on Base");
  const exp = Date.parse(p.expiresAt);
  check(exp > Date.now() && exp <= Date.now() + 300_000, `proposal expiry ${p.expiresAt} is not within 5 minutes`);
  const unpaid = await httpsFetch(p.request.url, { method: p.request.method });
  check(unpaid.status === 402, `unpaid probe answered ${unpaid.status}, not 402`);
  const header = unpaid.headers.get("payment-required");
  check(header, "402 without a PAYMENT-REQUIRED header");
  const pr = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  check(
    pr.x402Version === 2 && Array.isArray(pr.accepts) && pr.accepts.length === 1,
    "402 is not a single-accept v2 payment request",
  );
  const a = pr.accepts[0];
  check(a.scheme === "exact" && a.network === p.chain, `accept ${a.scheme}/${a.network} does not match the proposal`);
  check(a.asset.toLowerCase() === p.payment.asset.toLowerCase(), "402 asset differs from the proposal asset");
  check(
    BigInt(a.amount) <= BigInt(p.payment.maxAmount),
    `402 asks ${a.amount} > proposal maxAmount ${p.payment.maxAmount}`,
  );
  check(pr.resource?.url === p.request.url, "402 resource.url differs from the proposal URL");
  const unpaidBody = await unpaid.json();
  // Default client settings: spend controls ON (USDC on Base is a default asset; default cap $1 per payment), so the
  // $1 Countdown is payable by an unconfigured x402 client. Above $1 the proposal's maxAmount (PayBox's approval) is
  // the cap, so the library's own default cap is switched off for those.
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  if (BigInt(a.amount) > 1_000_000n) client.setSpendControls(false);
  const x = new x402HTTPClient(client);
  const required = x.getPaymentRequiredResponse((n) => unpaid.headers.get(n), unpaidBody);
  const payload = await x.createPaymentPayload(required);
  const headers = x.encodePaymentSignatureHeader(payload);
  const t0 = Date.now();
  const paid = await httpsFetch(p.request.url, { method: p.request.method, headers });
  const ms = Date.now() - t0;
  const text = await paid.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return {
    status: paid.status,
    body,
    text,
    ms,
    headers,
    accept: a,
    paymentResponse: paid.headers.get("payment-response"),
    t0,
  };
}

/** A signed x402 v2 PAYMENT-SIGNATURE header set for the 402 at `url` (fresh EIP-3009 nonce each call). */
async function signFor(url, account) {
  const unpaid = await httpsFetch(url, { method: "POST" });
  check(unpaid.status === 402, `unpaid ${unpaid.status}`);
  const body = await unpaid.json();
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const x = new x402HTTPClient(client);
  const required = x.getPaymentRequiredResponse((n) => unpaid.headers.get(n), body);
  const payload = await x.createPaymentPayload(required);
  return { headers: x.encodePaymentSignatureHeader(payload), nonce: payload.payload.authorization.nonce };
}

/** KFC1 seal with a raw per-file key (what the Studio CLI does with the job's kfc1.k_file), frozen §5. */
function sealKfc1(plain, kFileHex, saltHex, media) {
  const CHUNK = 1_048_560;
  const n = Math.max(1, Math.ceil(plain.byteLength / CHUNK));
  const key = Buffer.from(kFileHex.slice(2), "hex");
  const salt = Buffer.from(saltHex.slice(2), "hex");
  const u64 = (x) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(x));
    return b;
  };
  const chunks = [];
  const ciphertext = [];
  const plaintext = [];
  for (let i = 0; i < n; i++) {
    const part = plain.subarray(i * CHUNK, Math.min(plain.byteLength, (i + 1) * CHUNK));
    const c = createCipheriv("aes-256-gcm", key, Buffer.concat([Buffer.alloc(4), u64(i)]));
    c.setAAD(Buffer.concat([Buffer.from("KFC1"), salt, u64(i), u64(n)]));
    const ct = Buffer.concat([c.update(part), c.final(), c.getAuthTag()]);
    chunks.push(ct);
    ciphertext.push(sha256hex(ct));
    plaintext.push(sha256hex(part));
  }
  const manifest = {
    v: 1,
    alg: "KFC1",
    salt: saltHex,
    chunkSize: CHUNK,
    size: plain.byteLength,
    chunks: n,
    plaintextSha256: sha256hex(plain),
    ciphertext,
    plaintext,
    media,
  };
  return { manifest, chunks };
}

async function fundUsdc(to, amount) {
  await rpc("anvil_impersonateAccount", [USDC_HOLDER]);
  const holder = createWalletClient({ chain: base, transport: http(ANVIL) });
  const hash = await holder.sendTransaction({
    account: USDC_HOLDER,
    to: USDC,
    data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] }),
  });
  await pub.waitForTransactionReceipt({ hash });
  await rpc("anvil_stopImpersonatingAccount", [USDC_HOLDER]);
  return hash;
}

async function sendFromBuyer(buyerWallet, tx) {
  const hash = await buyerWallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? "0") });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

// ------------------------------------------------------------------------------------------------ RPC proxy (fault injection)

const RELEASE_SELECTOR = toFunctionSelector(
  "release((address,address,address,address,uint256,uint64,uint64,uint32,uint16,uint16,bytes32,bytes32,bytes32,bytes32),bytes32,uint256,bytes32)",
);
const proxyState = { blockRelease: false, blocked: 0, forwarded: 0 };
function callData(m) {
  try {
    if (m.method === "eth_estimateGas" || m.method === "eth_call" || m.method === "eth_sendTransaction") {
      const p = m.params?.[0] ?? {};
      return { to: p.to, data: p.data ?? p.input };
    }
    if (m.method === "eth_sendRawTransaction") {
      const t = parseTransaction(m.params[0]);
      return { to: t.to, data: t.data };
    }
  } catch {}
  return null;
}
const isBlocked = (m) => {
  if (!proxyState.blockRelease) return false;
  const c = callData(m);
  return !!(
    c?.data &&
    c.to &&
    FACTORY &&
    c.data.toLowerCase().startsWith(RELEASE_SELECTOR) &&
    isAddressEqual(c.to, FACTORY)
  );
};
/** The API's RPC goes through this proxy so a test can simulate "release is blocked" (relayer/RPC outage). */
async function startRpcProxy() {
  const port = await freePort();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const batch = Array.isArray(body);
    const items = batch ? body : [body];
    const out = new Array(items.length);
    const pass = [];
    items.forEach((m, i) => {
      if (isBlocked(m)) {
        proxyState.blocked++;
        out[i] = {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32603, message: "e2e: release blocked (simulated relayer RPC outage)" },
        };
      } else pass.push(i);
    });
    if (pass.length > 0) {
      proxyState.forwarded += pass.length;
      const fwd = pass.map((i) => items[i]);
      const r = await fetch(ANVIL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch ? fwd : fwd[0]),
      });
      const j = await r.json();
      const answers = Array.isArray(j) ? j : [j];
      for (const a of answers) {
        const idx = pass.find((i) => items[i].id === a.id && out[i] === undefined);
        if (idx !== undefined) out[idx] = a;
      }
      pass.forEach((i, k) => {
        if (out[i] === undefined) out[i] = answers[k];
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(batch ? out : out[0]));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// ------------------------------------------------------------------------------------------------ main

const servers = [];
let api = "";
let workerProc;
let workerEnvFile = "";
let workerHealth = "";
let WORKER_TOKEN = "";

async function startWorker() {
  workerProc = startProc("worker", process.execPath, [`--env-file=${workerEnvFile}`, "src/cli.ts", "serve"], {
    cwd: WORKER_DIR,
    env: { ...process.env, NODE_ENV: "production" },
  });
  await waitFor(
    "render worker /readyz",
    async () => (await fetch(`${workerHealth}/readyz`)).status === 200,
    90_000,
    500,
  );
}

async function scheduled() {
  const before = (tails.wrangler ?? []).filter((l) => l.includes('"event":"keeper_tick"')).length;
  const r = await fetch(`${api}/__scheduled?cron=*+*+*+*+*`);
  check(r.status === 200, `/__scheduled answered ${r.status}`);
  await r.text();
  const line = await waitFor(
    "the keeper_tick log line",
    () => {
      const ticks = (tails.wrangler ?? []).filter((l) => l.includes('"event":"keeper_tick"'));
      return ticks.length > before ? ticks[ticks.length - 1] : null;
    },
    60_000,
    250,
  );
  const tick = JSON.parse(line.slice(line.indexOf("{")));
  check(!tick.skipped, "keeper tick was skipped (lock held)");
  return tick;
}

async function main() {
  const tStart = Date.now();
  let buyer;
  let seller;
  let relayer;
  let deployer;
  let buyerWallet;
  let quoteMain;
  let paidMain;

  // ============================================================================== setup
  await scenario("setup", async () => {
    await step("0.1", "anvil fork of Base mainnet at the pinned block, clock synced to wall time", async () => {
      const port = await freePort();
      ANVIL = `http://127.0.0.1:${port}`;
      startProc("anvil", "anvil", [
        "--fork-url",
        FORK_URL,
        "--fork-block-number",
        String(FORK_BLOCK),
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--chain-id",
        "8453",
      ]);
      await waitFor("anvil", async () => (await rpc("eth_chainId")) === "0x2105", 90_000, 300);
      pub = createPublicClient({ chain: base, transport: http(ANVIL), pollingInterval: 100 });
      const forkBlock = await pub.getBlock({ blockNumber: BigInt(FORK_BLOCK) });
      report.fork.chain_id = 8453;
      report.fork.block_timestamp = Number(forkBlock.timestamp);
      await rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
      await rpc("evm_mine");
      const skew = (await chainNow()) - Math.floor(Date.now() / 1000);
      check(Math.abs(skew) <= 2, `chain clock skew ${skew} s after sync`);
      report.versions.anvil = execFileSync("anvil", ["--version"], { encoding: "utf8" }).split("\n")[0];
      report.versions.forge = execFileSync("forge", ["--version"], { encoding: "utf8" }).split("\n")[0];
      return `chain 8453, fork block ${FORK_BLOCK} (ts ${forkBlock.timestamp}), skew ${skew} s`;
    });

    await step(
      "0.2",
      "fresh keys (cast wallet new), ETH via anvil_setBalance, real USDC from an impersonated holder",
      async () => {
        const fresh = () => {
          const j = JSON.parse(execFileSync("cast", ["wallet", "new", "--json"], { encoding: "utf8" }));
          const w = (j.data ?? j)[0];
          addSecret(w.private_key);
          const account = privateKeyToAccount(w.private_key);
          rawKeys.set(account.address, w.private_key);
          return account;
        };
        buyer = fresh();
        seller = fresh();
        relayer = fresh();
        deployer = fresh();
        report.addresses = {
          buyer: buyer.address,
          seller: seller.address,
          operator_relayer: relayer.address,
          deployer: deployer.address,
          usdc: USDC,
          usdc_holder_impersonated: USDC_HOLDER,
        };
        for (const a of [buyer, seller, relayer, deployer]) {
          check((await pub.getCode({ address: a.address })) === undefined, `${a.address} unexpectedly has code`);
          await rpc("anvil_setBalance", [a.address, "0x8AC7230489E80000"]); // 10 ETH
        }
        await rpc("anvil_impersonateAccount", [USDC_HOLDER]);
        await rpc("anvil_setBalance", [USDC_HOLDER, "0xDE0B6B3A7640000"]);
        const holder = createWalletClient({ chain: base, transport: http(ANVIL) });
        const hash = await holder.sendTransaction({
          account: USDC_HOLDER,
          to: USDC,
          data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [buyer.address, BUYER_USDC] }),
        });
        const rc = await pub.waitForTransactionReceipt({ hash });
        await rpc("anvil_stopImpersonatingAccount", [USDC_HOLDER]);
        check(rc.status === "success", "USDC transfer from the holder reverted");
        report.txs.fund_buyer_usdc = hash;
        const bal = await usdcOf(buyer.address);
        check(bal === BUYER_USDC, `buyer holds ${bal} atomic USDC`);
        buyerWallet = createWalletClient({ account: buyer, chain: base, transport: http(ANVIL) });
        return `buyer ${buyer.address} holds ${bal} atomic USDC (plain EOA); seller ${seller.address}; operator ${relayer.address}`;
      },
    );

    await step(
      "0.3",
      "deploy KeyframeEscrowFactory with contracts/script/Deploy.s.sol (SELLER = seller key)",
      async () => {
        const outRel = "deployments/local/e2e-fork-8453.json";
        rmSync(join(CONTRACTS, outRel), { force: true });
        const out = execFileSync(
          "forge",
          [
            "script",
            "script/Deploy.s.sol:Deploy",
            "--rpc-url",
            ANVIL,
            "--broadcast",
            "--private-key",
            secretKeyOf(deployer),
          ],
          {
            cwd: CONTRACTS,
            encoding: "utf8",
            env: {
              ...process.env,
              USDC,
              SELLER: seller.address,
              DEPLOYMENT_OUT: outRel,
              FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        writeFileSync(join(RUN_DIR, "deploy.log"), redact(out));
        const dep = JSON.parse(readFileSync(join(CONTRACTS, outRel), "utf8"));
        writeFileSync(join(RUN_DIR, "deployment.json"), JSON.stringify(dep, null, 2));
        FACTORY = getAddress(dep.factory);
        VAULT_IMPL = getAddress(dep.vaultImpl);
        factoryAbi = JSON.parse(
          readFileSync(join(CONTRACTS, "out/KeyframeEscrowFactory.sol/KeyframeEscrowFactory.json"), "utf8"),
        ).abi;
        const runLatest = JSON.parse(
          readFileSync(join(CONTRACTS, "broadcast/Deploy.s.sol/8453/run-latest.json"), "utf8"),
        );
        report.txs.deploy_factory = runLatest.transactions?.[0]?.hash ?? null;
        const [impl, s, u] = await Promise.all(
          ["VAULT_IMPL", "SELLER", "USDC"].map((fn) =>
            pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: fn }),
          ),
        );
        check(
          isAddressEqual(impl, VAULT_IMPL) && isAddressEqual(s, seller.address) && isAddressEqual(u, USDC),
          "factory immutables mismatch",
        );
        report.addresses.factory = FACTORY;
        report.addresses.vault_impl = VAULT_IMPL;
        return `factory ${FACTORY}, vault impl ${VAULT_IMPL}, tx ${report.txs.deploy_factory}`;
      },
    );

    await step(
      "0.4",
      "API bundle in workerd (wrangler dev --local: D1 + KV + R2 + relayer DO + cron), configured and screening",
      async () => {
        // OFAC list served locally (fail-closed screening needs a fresh list); one address is on it for the 451 check.
        const sanctioned = getAddress(`0x${randomBytes(20).toString("hex")}`);
        report.addresses.sanctioned_test_address = sanctioned;
        const listPort = await freePort();
        const list = createServer((_q, r) => {
          r.writeHead(200, { "content-type": "application/json" });
          r.end(
            JSON.stringify([
              ...Array.from({ length: 20 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`),
              sanctioned.toLowerCase(),
            ]),
          );
        });
        await new Promise((r) => list.listen(listPort, "127.0.0.1", r));
        servers.push(list);
        const proxy = await startRpcProxy();
        servers.push(proxy);

        KMASTER_HEX = randomBytes(32).toString("hex");
        const accessSecret = randomBytes(32).toString("hex");
        WORKER_TOKEN = randomBytes(36).toString("base64url");
        [KMASTER_HEX, accessSecret, WORKER_TOKEN].forEach(addSecret);
        const secretsFile = join(RUN_DIR, "api.secrets.env");
        writeSecretFile(
          secretsFile,
          [
            `KMASTER=${KMASTER_HEX}`,
            `ACCESS_SECRET=${accessSecret}`,
            `WORKER_TOKEN=${WORKER_TOKEN}`,
            `RELAYER_PRIVATE_KEY=${secretKeyOf(relayer)}`,
          ].join("\n"),
        );
        const vars = {
          PUBLIC_BASE_URL: PUBLIC_BASE,
          FILES_BASE_URL: FILES_BASE,
          FACTORY_ADDRESS: FACTORY,
          SELLER_ADDRESS: seller.address,
          OPERATOR_ADDRESS: relayer.address,
          RPC_URL: proxy.url,
          // eth_getLogs straight from the fork (the default public Base RPC knows nothing of fork-local logs). anvil
          // forwards the pre-fork part of a range to FORK_URL (Alchemy free tier: ≤ 10 blocks), so wide scans that
          // reach before the fork block are refused and the API falls back to ≤ 10-block chunks on RPC_URL.
          LOGS_RPC_URL: ANVIL,
          LOGS_MAX_RANGE: "2000",
          X402_WIRE: "v2",
          FACILITATOR_FALLBACK_URL: "",
          MAX_AMOUNT: "50000000",
          QUOTE_TTL_S: "600",
          DRAFT_TTL_S: "900",
          MIN_RELEASE_MARGIN_S: "300",
          STUDIO_REVIEW_S: "86400",
          STUDIO_KILL_FEE_BPS: "0",
          STUDIO_MAX_OPEN: "3",
          MAX_INFLIGHT_ORDERS: "20",
          RECEIPT_WAIT_MS: "1200",
          OFAC_LIST_URL: `http://127.0.0.1:${listPort}/sanctioned_addresses_ETH.json`,
          OFAC_MAX_AGE_S: "604800",
          OFAC_REFRESH_S: "21600",
          FORMATS_DISABLED: "chart_moment",
          QUOTES_PER_BUYER_PER_HOUR: "30",
          MAINTENANCE: "0",
        };
        const cfg = join(RUN_DIR, "wrangler.e2e.toml");
        writeFileSync(
          cfg,
          [
            "# Generated by apps/api/scripts/e2e-fork.mjs: apps/api/wrangler.toml with an R2 bucket and the local fork values.",
            'name = "keyframe-api-e2e"',
            `main = ${JSON.stringify(join(API_DIR, "src/worker.ts"))}`,
            'compatibility_date = "2026-09-30"',
            "workers_dev = true",
            "[triggers]",
            'crons = ["* * * * *"]',
            "[[d1_databases]]",
            'binding = "DB"',
            'database_name = "keyframe"',
            'database_id = "00000000-0000-0000-0000-000000000000"',
            `migrations_dir = ${JSON.stringify(join(API_DIR, "migrations"))}`,
            "[[kv_namespaces]]",
            'binding = "KV"',
            'id = "00000000000000000000000000000000"',
            "[[r2_buckets]]",
            'binding = "FILES"',
            'bucket_name = "keyframe-files-e2e"',
            "[[durable_objects.bindings]]",
            'name = "RELAYER"',
            'class_name = "Relayer"',
            "[[migrations]]",
            'tag = "v1"',
            'new_sqlite_classes = ["Relayer"]',
            "[vars]",
            ...Object.entries(vars).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
            "",
          ].join("\n"),
        );
        const wenv = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
        const mig = execFileSync(
          WRANGLER,
          ["d1", "migrations", "apply", "keyframe", "--local", "--config", cfg, "--persist-to", STATE],
          {
            cwd: API_DIR,
            encoding: "utf8",
            env: wenv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        writeFileSync(join(RUN_DIR, "d1-migrate.log"), redact(mig));
        const port = await freePort();
        const inspector = await freePort();
        api = `http://127.0.0.1:${port}`;
        startProc(
          "wrangler",
          WRANGLER,
          [
            "dev",
            "--config",
            cfg,
            "--local",
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
            "--inspector-port",
            String(inspector),
            "--persist-to",
            STATE,
            "--env-file",
            secretsFile,
            "--test-scheduled",
            "--show-interactive-dev-session=false",
          ],
          { cwd: API_DIR, env: wenv },
        );
        HOSTS = {
          [HOST.api]: api,
          [HOST.files]: `${api}/files`,
          [HOST.rpcA]: ANVIL,
          [HOST.rpcB]: ANVIL,
        };
        await waitFor("wrangler dev /health", async () => (await fetch(`${api}/health`)).status === 200, 120_000, 500);
        const refresh = await (
          await fetch(`${api}/internal/sanctions/refresh`, {
            method: "POST",
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
          })
        ).json();
        check(refresh.ok === true, `sanctions refresh failed: ${JSON.stringify(refresh)}`);
        const health = await (await fetch(`${api}/health`)).json();
        writeFileSync(join(RUN_DIR, "health.json"), JSON.stringify(health, null, 2));
        check(health.ok === true && health.configured === true, `health not ok: problems=${health.problems}`);
        check(health.storage === "r2", `storage is ${health.storage}, expected r2`);
        check(
          isAddressEqual(health.operator, relayer.address) && isAddressEqual(health.factory, FACTORY),
          "health operator/factory mismatch",
        );
        report.versions.wrangler = execFileSync(WRANGLER, ["--version"], { encoding: "utf8", env: wenv })
          .trim()
          .split("\n")
          .pop();
        return `PUBLIC_BASE_URL ${PUBLIC_BASE}, storage ${health.storage}, sanctions ${refresh.count} entries, operator ${health.operator}`;
      },
    );

    await step("0.5", "render worker (apps/worker serve, HyperFrames + ffmpeg) against the local API", async () => {
      const hp = await freePort();
      workerHealth = `http://127.0.0.1:${hp}`;
      workerEnvFile = join(RUN_DIR, "worker.secrets.env");
      writeSecretFile(
        workerEnvFile,
        [
          `API_BASE=${api}`,
          `WORKER_TOKEN=${WORKER_TOKEN}`,
          "WORKER_ID=e2e-fork-mac",
          "RENDER_LANES=1",
          "RENDER_WORKERS=3",
          `WORK_DIR=${join(RUN_DIR, "worker-work")}`,
          "KEEP_JOBS=0",
          "BROWSER_GPU=off",
          "POLL_INTERVAL_MS=1000",
          "HEALTH_HOST=127.0.0.1",
          `HEALTH_PORT=${hp}`,
          "LOG_LEVEL=info",
        ].join("\n"),
      );
      await startWorker();
      const h = await (await fetch(`${workerHealth}/healthz`)).json();
      return `ready (${h.status ?? "ok"})`;
    });

    await step(
      "0.6",
      "plugin bundle over MCP stdio lists exactly the 9 frozen tools (= tool-catalog.json)",
      async () => {
        report.bundle.sha256 = sha256hex(readFileSync(PLUGIN_BUNDLE));
        report.bundle.bytes = readFileSync(PLUGIN_BUNDLE).byteLength;
        pluginEnv = {
          KEYFRAME_API_BASE: PUBLIC_BASE,
          KEYFRAME_FILES_BASE: FILES_BASE,
          KEYFRAME_RPC_URLS: `https://${HOST.rpcA},https://${HOST.rpcB}`,
          KEYFRAME_IPFS_GATEWAY: "off",
          KEYFRAME_FACTORIES: JSON.stringify([{ address: FACTORY, vaultImpl: VAULT_IMPL, status: "active" }]),
          KEYFRAME_SELLERS: seller.address,
          KEYFRAME_OPERATORS: relayer.address,
          KEYFRAME_MAX_AMOUNT: "50000000",
          KEYFRAME_PRIMARY_RAIL: "x402",
          KEYFRAME_7702_POLICY: "direct-first",
          KEYFRAME_MAINTENANCE: "0",
        };
        writeFileSync(join(RUN_DIR, "plugin.env.json"), JSON.stringify(pluginEnv, null, 2));
        validateSample = (await import(pathToFileURL(join(PLUGIN_DIR, "scripts/schema.mjs")).href)).validateSample;
        const list = await mcp("tools/list", {});
        toolDefs = list.message.result.tools;
        const catalog = JSON.parse(readFileSync(join(PLUGIN_DIR, "tool-catalog.json"), "utf8"));
        const names = toolDefs.map((t) => t.name);
        check(
          names.length === 9 && JSON.stringify(names) === JSON.stringify(catalog.tools.map((t) => t.name)),
          `tools: ${names}`,
        );
        for (const t of toolDefs) {
          const snap = catalog.tools.find((c) => c.name === t.name);
          check(
            JSON.stringify(t.inputSchema) === JSON.stringify(snap.inputSchema),
            `${t.name} inputSchema differs from tool-catalog.json`,
          );
        }
        return `9 tools; dist/plugin.mjs sha256 ${report.bundle.sha256}`;
      },
    );

    await step("0.7", "sanctions gate: a listed buyer gets 451 from the API and no quote from the plugin", async () => {
      const body = {
        buyer: report.addresses.sanctioned_test_address,
        format: "countdown",
        rights_confirmed: true,
        params: { style: "tminus", label: "Mainnet", target: new Date(Date.now() + 86_400_000).toISOString() },
      };
      const r = await fetch(`${api}/v1/quotes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      check(r.status === 451, `API answered ${r.status}`);
      const t = await tool("keyframe_quote", { ...body, aspect: "9:16" });
      check(t.isError === true && /451/.test(t.text), "plugin did not refuse the sanctioned buyer");
      return "API 451; keyframe_quote isError (HTTP 451)";
    });
  });
  const setupOk = report.steps.every((s) => s.status === "pass");
  if (!setupOk) return finish(tStart);

  const countdownParams = (label) => ({
    style: "tminus",
    label,
    target: new Date(Math.ceil((Date.now() + 2 * 86_400_000) / 60_000) * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  });
  const quoteArgs = (label, extra = {}) => ({
    buyer: buyer.address,
    format: "countdown",
    aspect: "9:16",
    rights_confirmed: true,
    params: countdownParams(label),
    ...extra,
  });
  /** Poll keyframe_status until the quote is final (worker rendered it and the API sealed it). */
  async function pollFinal(quoteId, timeoutMs = 240_000) {
    let last;
    await waitFor(
      `quote ${quoteId} final`,
      async () => {
        last = await tool("keyframe_status", { quote_id: quoteId, wait_s: 6 });
        check(!last.isError, `keyframe_status error: ${last.text.slice(0, 300)}`);
        return last.sc.quote?.quote_status === "final";
      },
      timeoutMs,
      200,
    );
    return last;
  }

  // ============================================================================== 5. happy path
  await scenario("5 happy path (x402)", async () => {
    let quoteId;
    let draftAt;
    let finalAt;
    let statusFinal;
    let proposal;
    let pay;
    const buyer0 = await usdcOf(buyer.address);
    const seller0 = await usdcOf(seller.address);

    await step("5.1", "keyframe_styles: live catalog with countdown available", async () => {
      const r = await tool("keyframe_styles", {});
      check(!r.isError && r.sc.source === "live", `source ${r.sc?.source}`);
      const cd = r.sc.formats.find((f) => f.id === "countdown");
      check(cd && cd.available === true && cd.styles.includes("tminus"), "countdown/tminus not available");
      check(isAddressEqual(r.sc.studio.factory, FACTORY), "catalog names another factory");
      return `countdown ${cd.prices.map((p) => `${p.duration_s}s=${p.usdc}`).join(",")} USDC, styles ${cd.styles}`;
    });

    await step("5.2", "keyframe_quote (countdown, 9:16) → draft quote, buyer route x402", async () => {
      draftAt = Date.now();
      const r = await tool("keyframe_quote", quoteArgs("Mainnet"));
      check(!r.isError, r.text.slice(0, 400));
      quoteId = r.sc.quote_id;
      check(
        r.sc.quote_status === "draft" && r.sc.payable === false,
        `status ${r.sc.quote_status} payable ${r.sc.payable}`,
      );
      check(failing(r.sc.checks).length === 0, `failing checks: ${JSON.stringify(failing(r.sc.checks))}`);
      return `${quoteId} draft, price ${r.sc.price.usdc} USDC, ${r.ms} ms`;
    });

    await step(
      "5.3",
      "poll keyframe_status until final (worker rendered + API sealed T.contentHash = manifestHash)",
      async () => {
        statusFinal = await pollFinal(quoteId);
        finalAt = Date.now();
        const q = statusFinal.sc.quote;
        report.timings.quote_to_final_s = sec(finalAt - draftAt);
        check(q.payable === true, "final quote is not payable");
        check(failing(q.checks).length === 0, `failing checks: ${JSON.stringify(failing(q.checks))}`);
        check(q.route?.kind === "x402" && q.route.wallet.kind === "plain", `route ${JSON.stringify(q.route)}`);
        const must = [
          "terms_hash",
          "escrow_address",
          "factory_allowlisted",
          "live_402",
          "file_committed",
          "preview_matches_deal",
          "escrow_unused",
          "spec_hash",
        ];
        const passed = checkIds(q.checks, "pass");
        for (const id of must)
          check(passed.includes(id), `check ${id} did not pass (${JSON.stringify(q.checks.find((c) => c.id === id))})`);
        const apiQ = await (await fetch(`${api}/v1/quotes/${quoteId}`)).json();
        quoteMain = apiQ;
        check(apiQ.terms.contentHash === apiQ.content.manifest_hash, "contentHash != manifest_hash");
        check(isAddressEqual(apiQ.escrow, q.escrow.address), "plugin escrow != API escrow");
        return `final after ${report.timings.quote_to_final_s} s; E ${apiQ.escrow}; manifest ${apiQ.content.manifest_hash}; checks pass: ${passed.length}, warn/skip: ${[...checkIds(q.checks, "warn"), ...checkIds(q.checks, "skip")].join(",") || "none"}`;
      },
    );

    await step("5.4", "keyframe_commission → strict x402 proposal (POST order URL, maxAmount = T.amount)", async () => {
      const r = await tool("keyframe_commission", { quote_id: quoteId });
      check(!r.isError, r.text.slice(0, 400));
      proposal = r.sc;
      const p = proposal[PROPOSAL];
      check(Object.keys(r.sc).length === 1 && p.kind === "x402", "structuredContent is not exactly one x402 proposal");
      check(
        p.request.url === `${PUBLIC_BASE}/v1/orders/${quoteId}` && p.request.method === "POST",
        `request ${JSON.stringify(p.request)}`,
      );
      check(
        p.payment.maxAmount === quoteMain.terms.amount,
        `maxAmount ${p.payment.maxAmount} != T.amount ${quoteMain.terms.amount}`,
      );
      check(r.text.includes(quoteMain.escrow), "guidance text does not name the escrow");
      return `maxAmount ${p.payment.maxAmount}, expires ${p.expiresAt}`;
    });

    await step(
      "5.5",
      "PayBox emulation: 402 probe, EIP-3009 signed by the buyer (@x402/evm exact), PAYMENT-SIGNATURE retry → 200",
      async () => {
        pay = await payX402(proposal, buyer);
        check(pay.accept.payTo.toLowerCase() === quoteMain.escrow.toLowerCase(), "402 payTo != E");
        check(pay.status === 200, `paid request answered ${pay.status}: ${pay.text.slice(0, 300)}`);
        paidMain = pay.body;
        report.timings.pay_to_200_s = sec(pay.ms);
        report.txs.happy_funding = pay.body.funding_tx;
        return `200 in ${pay.ms} ms, funding ${pay.body.funding} tx ${pay.body.funding_tx}`;
      },
    );

    await step("5.6", "paid 200 body has the frozen shape (§7)", async () => {
      const b = paidMain;
      const keys = [
        "v",
        "order_id",
        "access_token",
        "quote_id",
        "terms_hash",
        "escrow",
        "amount",
        "deadline",
        "funding_tx",
        "funding",
        "k_buyer",
        "status_url",
        "next",
      ];
      for (const k of keys) check(k in b, `paid body lacks ${k}`);
      check(
        /^o_[1-9A-HJ-NP-Za-km-z]{22}$/.test(b.order_id) && /^[A-Za-z0-9_-]{43}$/.test(b.access_token),
        "order_id/access_token format",
      );
      check(
        b.quote_id === quoteId &&
          b.terms_hash === quoteMain.terms_hash &&
          b.escrow === quoteMain.escrow &&
          b.amount === quoteMain.terms.amount,
        "paid body does not match the quote",
      );
      check(
        b.next === "keyframe_verify" && b.k_buyer === null && b.status_url === `${PUBLIC_BASE}/v1/orders/${b.order_id}`,
        "next/k_buyer/status_url",
      );
      check(b.funding === "confirmed" || b.funding === "pending", `funding ${b.funding}`);
      if (pay.paymentResponse) {
        const pr = JSON.parse(Buffer.from(pay.paymentResponse, "base64").toString());
        check(pr.success === true && pr.transaction === b.funding_tx, "PAYMENT-RESPONSE header mismatch");
      }
      return `order ${b.order_id}, funding ${b.funding}${pay.paymentResponse ? ", PAYMENT-RESPONSE header ok" : ""}`;
    });

    await step("5.7", "keyframe_verify funding with the paid body", async () => {
      const r = await tool("keyframe_verify", { mode: "funding", paid_response: paidMain });
      check(!r.isError, r.text.slice(0, 400));
      check(
        r.sc.verdict === "verified",
        `verdict ${r.sc.verdict}: ${JSON.stringify(r.sc.checks.filter((c) => c.status !== "pass"))}`,
      );
      check(["SEALED", "KEY PUBLISHED"].includes(r.sc.envelope), `envelope ${r.sc.envelope}`);
      return `verdict ${r.sc.verdict}, envelope ${r.sc.envelope}`;
    });

    await step("5.8", "the API releases on-chain (relayer → factory.release)", async () => {
      await waitFor(
        "Released",
        async () => {
          const v = await orderOf(quoteMain.terms_hash);
          return v.status === 3 ? v : null;
        },
        60_000,
        200,
      );
      report.timings.pay_to_released_s = sec(Date.now() - pay.t0);
      const relLogs = await pub.getContractEvents({
        address: FACTORY,
        abi: factoryAbi,
        eventName: "Released",
        args: { termsHash: quoteMain.terms_hash },
        fromBlock: BigInt(FORK_BLOCK + 1),
      });
      check(relLogs.length === 1, `${relLogs.length} Released events`);
      const releaseTx = relLogs[0].transactionHash;
      report.txs.happy_release = releaseTx;
      // The API's own record catches up once its receipt wait returns (runAction → finishPending).
      const ord = await waitFor(
        "API order key_published",
        async () => {
          const j = await (await fetch(`${api}/v1/orders/${paidMain.order_id}?token=${paidMain.access_token}`)).json();
          return j.status === "key_published" ? j : null;
        },
        30_000,
        250,
      );
      check(ord.release_tx === releaseTx, `API release_tx ${ord.release_tx} != chain ${releaseTx}`);
      const [fr, rr] = await Promise.all([
        pub.getTransactionReceipt({ hash: paidMain.funding_tx }),
        pub.getTransactionReceipt({ hash: releaseTx }),
      ]);
      const [fb, rb] = await Promise.all([
        pub.getBlock({ blockNumber: fr.blockNumber }),
        pub.getBlock({ blockNumber: rr.blockNumber }),
      ]);
      report.timings.funding_to_release_blocks = Number(rr.blockNumber - fr.blockNumber);
      report.timings.funding_to_release_chain_s = Number(rb.timestamp - fb.timestamp);
      check(rr.status === "success" && isAddressEqual(rr.to, FACTORY), "release tx not to the factory");
      check(isAddressEqual(rr.from, relayer.address), "release not sent by the operator key");
      const d = decodeFunctionData({ abi: factoryAbi, data: (await pub.getTransaction({ hash: releaseTx })).input });
      check(
        d.functionName === "release" &&
          d.args[2] === BigInt(quoteMain.terms.amount) &&
          d.args[3] === quoteMain.content.manifest_hash,
        "release args",
      );
      report.gas = {
        ...(report.gas ?? {}),
        fund_with_authorization: fr.gasUsed.toString(),
        release: rr.gasUsed.toString(),
      };
      return `Released ${report.timings.pay_to_released_s} s after pay; release tx ${releaseTx} (charge ${d.args[2]}); API status ${ord.status}; gas fund ${fr.gasUsed} / release ${rr.gasUsed}`;
    });

    await step(
      "5.9",
      "keyframe_verify delivery: key from order(), chunks fetched, decrypted, hashes + MP4 header → verified",
      async () => {
        const r = await tool("keyframe_verify", { mode: "delivery", paid_response: paidMain });
        check(!r.isError, r.text.slice(0, 400));
        check(
          r.sc.verdict === "verified",
          `verdict ${r.sc.verdict}: ${JSON.stringify(r.sc.checks.filter((c) => c.status !== "pass"))}`,
        );
        check(r.sc.envelope === "KEY PUBLISHED", `envelope ${r.sc.envelope}`);
        const d = r.sc.delivery;
        check(
          d && d.chunks_verified === d.chunks_total && d.chunks_total >= 1,
          `chunks ${d?.chunks_verified}/${d?.chunks_total}`,
        );
        check(d.media && d.media.width === 1080 && d.media.height === 1920, `media ${JSON.stringify(d.media)}`);
        return `verified; ${d.chunks_verified}/${d.chunks_total} chunks, ${d.bytes_total} bytes, ${d.media.width}x${d.media.height} ${d.media.duration_ms} ms; ${r.ms} ms`;
      },
    );

    await step(
      "5.10",
      "on-chain: buyer −amount, seller +charge, E is the EIP-1167 clone, Released, key == K_chain",
      async () => {
        const amount = BigInt(quoteMain.terms.amount);
        const o = await orderOf(quoteMain.terms_hash);
        const [b1, s1, code, eBal] = await Promise.all([
          usdcOf(buyer.address),
          usdcOf(seller.address),
          pub.getCode({ address: quoteMain.escrow }),
          usdcOf(quoteMain.escrow),
        ]);
        check(b1 === buyer0 - amount, `buyer delta ${b1 - buyer0}`);
        check(
          s1 - seller0 === o.toSeller && o.toSeller === amount,
          `seller delta ${s1 - seller0}, toSeller ${o.toSeller}`,
        );
        check(o.toBuyer === 0n && eBal === 0n, `toBuyer ${o.toBuyer}, E balance ${eBal}`);
        check(code?.toLowerCase() === cloneCode(VAULT_IMPL), `E code ${code}`);
        check(o.status === 3, `status ${o.statusName}`);
        const k = kChainOf(quoteId);
        check(o.key.toLowerCase() === k, "order().key != HMAC(KMASTER, kf/kchain/v1/quote_id)");
        check(keccak256(o.key) === quoteMain.terms.keyHash, "keccak(key) != T.keyHash");
        check(o.manifestHash === quoteMain.content.manifest_hash, "manifestHash != contentHash");
        const viaFactory = await pub.readContract({
          address: FACTORY,
          abi: factoryAbi,
          functionName: "escrowOf",
          args: [quoteMain.terms_hash],
        });
        check(isAddressEqual(viaFactory, quoteMain.escrow), "factory.escrowOf != E");
        return `buyer −${amount}, seller +${o.toSeller}, E code = clone(${VAULT_IMPL}), key = K_chain`;
      },
    );

    await step(
      "5.11",
      "keyframe_status on the order → KEY PUBLISHED; exact replay of the payment returns the same 200 bytes",
      async () => {
        const r = await tool("keyframe_status", { order_id: paidMain.order_id, access_token: paidMain.access_token });
        check(!r.isError && r.sc.envelope === "KEY PUBLISHED", `envelope ${r.sc?.envelope}`);
        const replay = await httpsFetch(proposal[PROPOSAL].request.url, { method: "POST", headers: pay.headers });
        const text = await replay.text();
        check(replay.status === 200 && text === pay.text, `replay ${replay.status}`);
        const after = await usdcOf(buyer.address);
        check(after === buyer0 - BigInt(quoteMain.terms.amount), "replay moved money");
        return "KEY PUBLISHED; replay byte-identical, no second charge";
      },
    );

    await step("5.12", "keyframe_orders: SIWE recovery in a new chat (message signed by the buyer key)", async () => {
      const s1 = await tool("keyframe_orders", { address: buyer.address });
      check(!s1.isError && s1.sc.stage === "sign" && s1.sc.message, s1.text.slice(0, 300));
      const signature = await buyer.signMessage({ message: s1.sc.message });
      const s2 = await tool("keyframe_orders", { address: buyer.address, message: s1.sc.message, signature });
      check(!s2.isError && s2.sc.stage === "signed_in", s2.text.slice(0, 300));
      const mine = s2.sc.orders.find((o) => o.order_id === paidMain.order_id);
      check(mine && mine.access_token === paidMain.access_token, "recovered orders lack the paid order / token");
      return `${s2.sc.orders.length} order(s) recovered with access tokens`;
    });
  });

  // ============================================================================== 8. determinism (+ draft never 402)
  let quoteB;
  await scenario("8 determinism", async () => {
    let qid;
    await step(
      "8.1",
      "worker stopped: a fresh quote stays draft and its order URL never serves a 402 (425, no PAYMENT-REQUIRED)",
      async () => {
        await stopProc(workerProc, 30_000);
        check(workerProc.exited, "worker did not stop");
        const r = await tool("keyframe_quote", quoteArgs("Determinism"));
        check(!r.isError && r.sc.quote_status === "draft", r.text.slice(0, 300));
        qid = r.sc.quote_id;
        const variants = [
          { method: "POST" },
          { method: "GET" },
          { method: "PUT", body: "{}" },
          { method: "GET", headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } },
          { method: "POST", headers: { "payment-signature": "e30=" } },
        ];
        const seen = [];
        for (let round = 0; round < 2; round++) {
          for (const v of variants) {
            const res = await httpsFetch(`${PUBLIC_BASE}/v1/orders/${qid}`, v);
            await res.text();
            check(res.status === 425 && res.headers.get("payment-required") === null, `${v.method} → ${res.status}`);
            seen.push(res.status);
          }
          if (round === 0) await sleep(5_000);
        }
        const c = await tool("keyframe_commission", { quote_id: qid });
        check(c.isError === true && !c.sc?.[PROPOSAL], "keyframe_commission proposed on a draft");
        const d = await tool("keyframe_commission_direct", { quote_id: qid });
        check(d.isError === true && !d.sc?.[PROPOSAL], "keyframe_commission_direct proposed on a draft");
        return `${seen.length} requests over 5 s → all 425 without PAYMENT-REQUIRED; both payment tools refused`;
      },
    );

    await step("8.2", "worker restarted → the queued render is claimed and the quote turns final", async () => {
      const t0 = Date.now();
      await startWorker();
      await pollFinal(qid);
      report.timings.quote_to_final_after_restart_s = sec(Date.now() - t0);
      quoteB = await (await fetch(`${api}/v1/quotes/${qid}`)).json();
      return `final ${report.timings.quote_to_final_after_restart_s} s after restart`;
    });

    await step(
      "8.3",
      "the 402 of a final quote is byte-identical across POST/GET and different Accept/User-Agent",
      async () => {
        const variants = [
          { method: "POST" },
          {
            method: "GET",
            headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (Macintosh)" },
          },
          {
            method: "POST",
            headers: { accept: "application/json", "user-agent": "curl/8.7.1", "content-type": "application/json" },
            body: '{"x":1}',
          },
        ];
        const got = [];
        for (const v of variants) {
          const r = await httpsFetch(`${PUBLIC_BASE}/v1/orders/${qid}`, v);
          got.push({
            status: r.status,
            pr: r.headers.get("payment-required"),
            body: await r.text(),
            cc: r.headers.get("cache-control"),
          });
        }
        check(
          got.every((g) => g.status === 402 && g.pr),
          `statuses ${got.map((g) => g.status)}`,
        );
        check(
          new Set(got.map((g) => g.pr)).size === 1 && new Set(got.map((g) => g.body)).size === 1,
          "PAYMENT-REQUIRED or body differ",
        );
        check(got[0].body === "{}", `body ${got[0].body}`);
        const pr = JSON.parse(Buffer.from(got[0].pr, "base64").toString());
        check(
          pr.accepts[0].payTo === quoteB.escrow && pr.accepts[0].amount === quoteB.terms.amount,
          "402 does not pay E the amount",
        );
        check(pr.resource.url === `${PUBLIC_BASE}/v1/orders/${qid}`, "resource.url not canonical");
        const sha = sha256hex(got[0].pr);
        const st = await tool("keyframe_status", { quote_id: qid });
        const live = st.sc.quote.checks.find((c) => c.id === "live_402");
        check(
          live?.status === "pass" && live.detail.includes(sha.slice(0, 18)),
          "plugin probe saw different 402 bytes",
        );
        writeFileSync(join(RUN_DIR, "payment-required.json"), JSON.stringify(pr, null, 2));
        return `3/3 identical (sha256 ${sha}), body {}, cache-control ${got[0].cc}; plugin probe hash matches`;
      },
    );
  });

  // ============================================================================== 7. direct rail
  await scenario("7 direct rail", async () => {
    check(quoteB, "no final quote from scenario 8");
    const qid = quoteB.quote_id;
    let tx;
    const b0 = await usdcOf(buyer.address);
    const s0 = await usdcOf(seller.address);
    await step("7.1", "keyframe_commission_direct → evm proposal USDC.transfer(E, amount)", async () => {
      const r = await tool("keyframe_commission_direct", { quote_id: qid });
      check(!r.isError, r.text.slice(0, 400));
      const p = r.sc[PROPOSAL];
      check(
        p.kind === "evm" &&
          p.chain === "eip155:8453" &&
          isAddressEqual(p.transaction.to, USDC) &&
          p.transaction.value === "0",
        JSON.stringify(p),
      );
      const d = decodeFunctionData({ abi: erc20, data: p.transaction.data });
      check(
        d.functionName === "transfer" &&
          isAddressEqual(d.args[0], quoteB.escrow) &&
          d.args[1] === BigInt(quoteB.terms.amount),
        "calldata is not transfer(E, amount)",
      );
      tx = p.transaction;
      return `to USDC, transfer(${quoteB.escrow}, ${d.args[1]})`;
    });
    await step("7.2", "buyer sends the proposed transaction", async () => {
      const { hash, receipt } = await sendFromBuyer(buyerWallet, tx);
      check(receipt.status === "success", "direct transfer reverted");
      report.txs.direct_transfer = hash;
      tx.hash = hash;
      return `tx ${hash}`;
    });
    await step("7.3", "keyframe_verify funding with tx_hash → sealed (registration pending)", async () => {
      const r = await tool("keyframe_verify", { mode: "funding", quote_id: qid, tx_hash: tx.hash });
      check(!r.isError, r.text.slice(0, 400));
      const funded = r.sc.checks.find((c) => c.id === "funded");
      const ftx = r.sc.checks.find((c) => c.id === "funding_tx");
      check(
        funded?.status === "pass" && ftx?.status === "pass",
        `funded ${JSON.stringify(funded)} funding_tx ${JSON.stringify(ftx)}`,
      );
      check(r.sc.envelope === "SEALED", `envelope ${r.sc.envelope}`);
      return `verdict ${r.sc.verdict}, envelope ${r.sc.envelope}: ${funded.detail}`;
    });
    await step("7.4", "keeper cron (scheduled handler) registers T and the release follows", async () => {
      const t0 = Date.now();
      const tick = await scheduled();
      const o = await waitFor(
        "Released",
        async () => {
          const v = await orderOf(quoteB.terms_hash);
          return v.status === 3 ? v : null;
        },
        60_000,
        250,
      );
      report.timings.direct_keeper_to_released_s = sec(Date.now() - t0);
      const q = await (await fetch(`${api}/v1/quotes/${qid}`)).json();
      check(q.status === "paid", `quote status ${q.status}`);
      const regLogs = await pub.getContractEvents({
        address: FACTORY,
        abi: factoryAbi,
        eventName: "Opened",
        args: { termsHash: quoteB.terms_hash },
        fromBlock: BigInt(FORK_BLOCK + 1),
      });
      const relLogs = await pub.getContractEvents({
        address: FACTORY,
        abi: factoryAbi,
        eventName: "Released",
        args: { termsHash: quoteB.terms_hash },
        fromBlock: BigInt(FORK_BLOCK + 1),
      });
      report.txs.direct_register = regLogs[0]?.transactionHash ?? null;
      report.txs.direct_release = relLogs[0]?.transactionHash ?? null;
      const [b1, s1] = await Promise.all([usdcOf(buyer.address), usdcOf(seller.address)]);
      check(
        b1 === b0 - BigInt(quoteB.terms.amount) && s1 - s0 === o.toSeller && o.toSeller === BigInt(quoteB.terms.amount),
        "balances",
      );
      check(o.key.toLowerCase() === kChainOf(qid), "key != K_chain");
      check(
        (await pub.getCode({ address: quoteB.escrow }))?.toLowerCase() === cloneCode(VAULT_IMPL),
        "E is not the clone",
      );
      return `tick direct_opened=${tick.direct_opened}; Released ${report.timings.direct_keeper_to_released_s} s after the tick; register ${report.txs.direct_register}, release ${report.txs.direct_release}`;
    });
    await step("7.5", "keyframe_verify delivery (quote_id) → verified", async () => {
      const r = await tool("keyframe_verify", { mode: "delivery", quote_id: qid });
      check(
        !r.isError && r.sc.verdict === "verified",
        `verdict ${r.sc?.verdict}: ${JSON.stringify(r.sc?.checks?.filter((c) => c.status !== "pass"))}`,
      );
      return `verified; ${r.sc.delivery.chunks_verified}/${r.sc.delivery.chunks_total} chunks`;
    });
  });

  // ============================================================================== 9. adversarial payments
  await scenario("9 adversarial payments", async () => {
    let q;
    let url;
    await step("9.1", "a final quote for the race (keyframe_quote → final)", async () => {
      const r = await tool("keyframe_quote", quoteArgs("Race"));
      check(!r.isError, r.text.slice(0, 300));
      await pollFinal(r.sc.quote_id);
      q = await (await fetch(`${api}/v1/quotes/${r.sc.quote_id}`)).json();
      url = `${PUBLIC_BASE}/v1/orders/${q.quote_id}`;
      return q.quote_id;
    });
    await step(
      "9.2",
      "a stranger's valid authorization for the same 402 → 409 payer_mismatch, not charged",
      async () => {
        const strangerKey = `0x${randomBytes(32).toString("hex")}`;
        addSecret(strangerKey);
        const stranger = privateKeyToAccount(strangerKey);
        await fundUsdc(stranger.address, 2_000_000n);
        const before = await usdcOf(stranger.address);
        const { headers, nonce } = await signFor(url, stranger);
        const r = await httpsFetch(url, { method: "POST", headers });
        const j = await r.json();
        check(
          r.status === 409 && j.error === "payer_mismatch" && j.charged === false,
          `${r.status} ${JSON.stringify(j)}`,
        );
        const used = await pub.readContract({
          address: USDC,
          abi: parseAbi(["function authorizationState(address,bytes32) view returns (bool)"]),
          functionName: "authorizationState",
          args: [stranger.address, nonce],
        });
        check(
          !used && (await usdcOf(stranger.address)) === before && (await usdcOf(q.escrow)) === 0n,
          "stranger was charged",
        );
        return `409 payer_mismatch, charged:false; authorization unused on-chain`;
      },
    );
    await step(
      "9.3",
      "two concurrent authorizations from the buyer for one quote → exactly one 200, one charge",
      async () => {
        const b0 = await usdcOf(buyer.address);
        const [a, b] = [await signFor(url, buyer), await signFor(url, buyer)];
        check(a.nonce !== b.nonce, "nonces collide");
        const rs = await Promise.all([a, b].map((x) => httpsFetch(url, { method: "POST", headers: x.headers })));
        const out = await Promise.all(rs.map(async (r) => ({ status: r.status, body: await r.json() })));
        const ok = out.filter((o) => o.status === 200);
        const other = out.filter((o) => o.status !== 200);
        check(ok.length === 1 && other.length === 1, `statuses ${out.map((o) => o.status)}`);
        check(
          other[0].status === 409 && other[0].body.charged === false,
          `loser ${other[0].status} ${JSON.stringify(other[0].body)}`,
        );
        await waitFor("Released", async () => (await orderOf(q.terms_hash)).status === 3, 60_000, 250);
        const b1 = await usdcOf(buyer.address);
        check(b1 === b0 - BigInt(q.terms.amount), `buyer charged ${b0 - b1}`);
        const states = await Promise.all(
          [a, b].map((x) =>
            pub.readContract({
              address: USDC,
              abi: parseAbi(["function authorizationState(address,bytes32) view returns (bool)"]),
              functionName: "authorizationState",
              args: [buyer.address, x.nonce],
            }),
          ),
        );
        check(states.filter(Boolean).length === 1, `authorizations used: ${states}`);
        report.txs.race_funding = ok[0].body.funding_tx;
        return `200 + ${other[0].status} ${other[0].body.error} (charged:false); buyer charged once (${q.terms.amount}); 1 of 2 authorizations used on-chain; released`;
      },
    );
    await step(
      "9.4",
      "two different quotes paid concurrently → both 200 through the one relayer DO (serialized nonces), both released",
      async () => {
        const ids = [];
        for (const k of ["a", "b"]) {
          const r = await tool("keyframe_quote", quoteArgs(`Pair ${k}`));
          check(!r.isError, r.text.slice(0, 300));
          ids.push(r.sc.quote_id);
        }
        const qq = [];
        for (const id of ids) {
          await pollFinal(id);
          qq.push(await (await fetch(`${api}/v1/quotes/${id}`)).json());
        }
        const b0 = await usdcOf(buyer.address);
        const signed = [];
        for (const x of qq) signed.push(await signFor(`${PUBLIC_BASE}/v1/orders/${x.quote_id}`, buyer));
        const rs = await Promise.all(
          qq.map((x, i) =>
            httpsFetch(`${PUBLIC_BASE}/v1/orders/${x.quote_id}`, { method: "POST", headers: signed[i].headers }),
          ),
        );
        const out = await Promise.all(rs.map(async (r) => ({ status: r.status, text: await r.text() })));
        check(
          out.every((o) => o.status === 200),
          `statuses ${out.map((o) => `${o.status} ${o.text.slice(0, 120)}`)}`,
        );
        const bodies = out.map((o) => JSON.parse(o.text));
        for (const x of qq)
          await waitFor(`Released ${x.quote_id}`, async () => (await orderOf(x.terms_hash)).status === 3, 60_000, 250);
        const txs = await Promise.all(bodies.map((b) => pub.getTransaction({ hash: b.funding_tx })));
        check(
          txs[0].nonce !== txs[1].nonce && txs.every((t) => isAddressEqual(t.from, relayer.address)),
          "funding txs share a nonce or sender",
        );
        const b1 = await usdcOf(buyer.address);
        check(b0 - b1 === BigInt(qq[0].terms.amount) + BigInt(qq[1].terms.amount), `buyer charged ${b0 - b1}`);
        report.txs.pair_funding = bodies.map((b) => b.funding_tx);
        return `both 200 (funding ${bodies.map((b) => b.funding).join("/")}), relayer nonces ${txs.map((t) => t.nonce).join(",")}, both Released`;
      },
    );
  });

  // ============================================================================== 10. Base-like block time
  await scenario("10 Base-like 2 s blocks", async () => {
    let q;
    let paidB;
    let t0;
    await step("10.1", "anvil switched to 2 s interval mining; quote → final", async () => {
      await rpc("evm_setAutomine", [false]);
      await rpc("evm_setIntervalMining", [2]);
      const r = await tool("keyframe_quote", quoteArgs("Blocks"));
      check(!r.isError, r.text.slice(0, 300));
      await pollFinal(r.sc.quote_id);
      q = await (await fetch(`${api}/v1/quotes/${r.sc.quote_id}`)).json();
      return q.quote_id;
    });
    await step("10.2", "x402 payment with 2 s blocks → 200 (funding confirmed or pending per ADR-012)", async () => {
      const c = await tool("keyframe_commission", { quote_id: q.quote_id });
      check(!c.isError, c.text.slice(0, 300));
      const p = await payX402(c.sc, buyer);
      t0 = p.t0;
      check(p.status === 200, `${p.status} ${p.text.slice(0, 200)}`);
      paidB = p.body;
      report.timings.blocks2s_pay_to_200_s = sec(p.ms);
      report.txs.blocks2s_funding = paidB.funding_tx;
      return `200 in ${p.ms} ms, funding ${paidB.funding}`;
    });
    await step("10.3", "keyframe_verify funding right after the 200", async () => {
      const r = await tool("keyframe_verify", { mode: "funding", paid_response: paidB });
      check(!r.isError, r.text.slice(0, 300));
      const odd = r.sc.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
      report.observations.push(
        `10.3 funding=${paidB.funding}: verify funding verdict ${r.sc.verdict}, envelope ${r.sc.envelope}${odd.length ? `, non-pass ${odd.join(",")}` : ""}`,
      );
      check(
        r.sc.verdict !== "failed",
        `verdict failed right after a successful payment: ${JSON.stringify(r.sc.checks.filter((c) => c.status === "fail"))}`,
      );
      return `verdict ${r.sc.verdict}, envelope ${r.sc.envelope}${odd.length ? ` (${odd.join(",")})` : ""}`;
    });
    await step("10.4", "the release follows on 2 s blocks; keyframe_verify delivery → verified", async () => {
      await waitFor("Released", async () => (await orderOf(q.terms_hash)).status === 3, 90_000, 250);
      report.timings.blocks2s_pay_to_released_s = sec(Date.now() - t0);
      const st = await waitFor(
        "API key_published",
        async () => {
          const j = await (await fetch(`${api}/v1/orders/${paidB.order_id}`)).json();
          return j.status === "key_published" ? j : null;
        },
        60_000,
        500,
      );
      report.txs.blocks2s_release = st.release_tx;
      const r = await tool("keyframe_verify", { mode: "delivery", paid_response: paidB });
      check(!r.isError && r.sc.verdict === "verified", `verdict ${r.sc?.verdict}`);
      return `Released ${report.timings.blocks2s_pay_to_released_s} s after pay; delivery verified`;
    });
    await step(
      "10.5",
      "funding tx still unmined when the 200 is sent (mining paused) → funding pending; verify is partial, not failed; then sealed and released",
      async () => {
        const r = await tool("keyframe_quote", quoteArgs("Pending"));
        check(!r.isError, r.text.slice(0, 300));
        await pollFinal(r.sc.quote_id);
        const qp = await (await fetch(`${api}/v1/quotes/${r.sc.quote_id}`)).json();
        const c = await tool("keyframe_commission", { quote_id: qp.quote_id });
        check(!c.isError, c.text.slice(0, 300));
        await rpc("evm_setIntervalMining", [0]);
        let p;
        let v;
        try {
          p = await payX402(c.sc, buyer);
          check(p.status === 200 && p.body.funding === "pending", `paid ${p.status} funding ${p.body?.funding}`);
          v = await tool("keyframe_verify", { mode: "funding", paid_response: p.body });
          check(
            !v.isError && v.sc.verdict === "partial" && v.sc.envelope === "NOT SEALED",
            `verify ${v.sc?.verdict} ${v.sc?.envelope}`,
          );
          const funded = v.sc.checks.find((x) => x.id === "funded");
          check(funded?.status === "skip" && /not sealed yet/.test(funded.detail), `funded ${JSON.stringify(funded)}`);
          check(v.sc.next?.tool === "keyframe_status", `next ${v.sc.next?.tool}`);
        } finally {
          await rpc("evm_setIntervalMining", [2]);
        }
        report.txs.pending_funding = p.body.funding_tx;
        const t0 = Date.now();
        await waitFor(
          "Released after the funding tx is mined",
          async () => (await orderOf(qp.terms_hash)).status === 3,
          90_000,
          250,
        );
        report.timings.pending_mined_to_released_s = sec(Date.now() - t0);
        const after = await tool("keyframe_verify", { mode: "funding", paid_response: p.body });
        check(
          after.sc.verdict === "verified" && after.sc.envelope === "KEY PUBLISHED",
          `after ${after.sc.verdict} ${after.sc.envelope}`,
        );
        return `200 with funding pending; verify → partial / NOT SEALED (funded: skip, next keyframe_status); mining resumed → Released ${report.timings.pending_mined_to_released_s} s later; verify → verified / KEY PUBLISHED`;
      },
    );
    await rpc("evm_setIntervalMining", [0]).catch(() => undefined);
    await rpc("evm_setAutomine", [true]).catch(() => undefined);
  });
  await rpc("evm_setIntervalMining", [0]).catch(() => undefined);
  await rpc("evm_setAutomine", [true]).catch(() => undefined);

  // ============================================================================== 11. private delivery
  await scenario("11 private delivery", async () => {
    let q;
    let paidP;
    await step("11.1", "private countdown quote → final → x402 paid; the paid body carries k_buyer", async () => {
      const r = await tool("keyframe_quote", quoteArgs("Private", { delivery: "private" }));
      check(!r.isError && r.sc.delivery === "private", r.text.slice(0, 300));
      await pollFinal(r.sc.quote_id);
      q = await (await fetch(`${api}/v1/quotes/${r.sc.quote_id}`)).json();
      check(q.spec.delivery === "private" && /^0x[0-9a-f]{64}$/.test(q.spec.kBuyerHash ?? ""), "spec is not private");
      const c = await tool("keyframe_commission", { quote_id: q.quote_id });
      check(!c.isError, c.text.slice(0, 300));
      const p = await payX402(c.sc, buyer);
      check(
        p.status === 200 && /^0x[0-9a-f]{64}$/.test(p.body.k_buyer ?? ""),
        `paid ${p.status} k_buyer ${p.body?.k_buyer}`,
      );
      check(
        sha256hex(Buffer.from(p.body.k_buyer.slice(2), "hex")) === q.spec.kBuyerHash,
        "sha256(k_buyer) != spec.kBuyerHash",
      );
      paidP = p.body;
      report.txs.private_funding = p.body.funding_tx;
      await waitFor("Released", async () => (await orderOf(q.terms_hash)).status === 3, 60_000, 250);
      return `${q.quote_id}; sha256(k_buyer) = spec.kBuyerHash; released`;
    });
    await step(
      "11.2",
      "keyframe_verify delivery: verified with the paid body (k_buyer), refused to decrypt without it",
      async () => {
        const ok = await tool("keyframe_verify", { mode: "delivery", paid_response: paidP });
        check(
          !ok.isError && ok.sc.verdict === "verified",
          `with k_buyer: ${ok.sc?.verdict} ${JSON.stringify(ok.sc?.checks?.filter((c) => c.status !== "pass"))}`,
        );
        const no = await tool("keyframe_verify", { mode: "delivery", quote_id: q.quote_id });
        const kb = no.sc?.checks?.find((c) => c.id === "k_buyer");
        check(!no.isError && no.sc.verdict === "failed" && kb?.status === "fail", `without k_buyer: ${no.sc?.verdict}`);
        return `with k_buyer: verified (${ok.sc.delivery.chunks_verified}/${ok.sc.delivery.chunks_total}); without: failed at k_buyer`;
      },
    );
  });

  // ============================================================================== 12. Studio tier
  await scenario("12 Studio tier", async () => {
    let q;
    let paidS;
    let sig;
    const s0 = await usdcOf(seller.address);
    await step(
      "12.1",
      "studio_sting quote is final at once (review window, contentHash 0) → x402 paid (25 USDC)",
      async () => {
        const r = await tool("keyframe_quote", {
          buyer: buyer.address,
          format: "studio",
          aspect: "9:16",
          rights_confirmed: true,
          params: {
            deliverable: "studio_sting",
            brief: "A calm, precise ten second sting for an e2e fork run of the Keyframe escrow; no real people.",
          },
        });
        check(!r.isError && r.sc.quote_status === "final" && r.sc.tier === "studio", r.text.slice(0, 300));
        check(failing(r.sc.checks).length === 0, JSON.stringify(failing(r.sc.checks)));
        q = await (await fetch(`${api}/v1/quotes/${r.sc.quote_id}`)).json();
        check(
          q.terms.reviewWindow === 86400 && /^0x0{64}$/.test(q.terms.contentHash),
          `rw ${q.terms.reviewWindow} contentHash ${q.terms.contentHash}`,
        );
        const c = await tool("keyframe_commission", { quote_id: q.quote_id });
        check(!c.isError, c.text.slice(0, 300));
        const p = await payX402(c.sc, buyer);
        check(p.status === 200, `${p.status} ${p.text.slice(0, 200)}`);
        paidS = p.body;
        report.txs.studio_funding = p.body.funding_tx;
        await sleep(1_500);
        check(
          (await orderOf(q.terms_hash)).status === 1,
          "Studio order is not Open (an Instant release must not fire)",
        );
        return `${q.quote_id} paid ${q.terms.amount}; Open, not released`;
      },
    );
    await step(
      "12.2",
      "Studio CLI delivery: job with k_file → preview + KFC1 manifest/chunks → API relays deliver(T, manifestHash)",
      async () => {
        const auth = { authorization: `Bearer ${WORKER_TOKEN}`, "x-worker-id": "studio-cli-e2e" };
        const inbox = await (await fetch(`${api}/internal/studio/orders`, { headers: auth })).json();
        check(
          inbox.orders.some((o) => o.order_id === paidS.order_id),
          "order not in the Studio inbox",
        );
        const open = await fetch(`${api}/internal/studio/orders/${paidS.order_id}/delivery`, {
          method: "POST",
          headers: auth,
        });
        check(open.status === 200, `delivery ${open.status}`);
        const job = await open.json();
        addSecret(job.kfc1.k_file);
        const mp4 = readFileSync(join(API_DIR, "test/fixtures/studio-10s-9x16.m4v"));
        const sealed = sealKfc1(mp4, job.kfc1.k_file, job.kfc1.salt, {
          mime: "video/mp4",
          width: 1080,
          height: 1920,
          durationMs: 10_000,
          fps: 30,
        });
        const put = async (path, body, type) => {
          const r = await fetch(`${api}${path}`, { method: "PUT", headers: { ...auth, "content-type": type }, body });
          check(r.status === 200, `${path} → ${r.status} ${await r.text()}`);
        };
        await put(job.upload.preview, mp4, "video/mp4");
        await put(job.upload.manifest, JSON.stringify(sealed.manifest), "application/json");
        for (let i = 0; i < sealed.chunks.length; i++)
          await put(job.upload.chunk.replace("{i}", String(i)), sealed.chunks[i], "application/octet-stream");
        const done = await fetch(`${api}${job.upload.done}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: "{}",
        });
        const d = await done.json();
        check(
          done.status === 200 && (d.state === "confirmed" || d.state === "pending"),
          `done ${done.status} ${JSON.stringify(d)}`,
        );
        report.txs.studio_deliver = d.tx;
        const o = await waitFor(
          "Delivered",
          async () => {
            const v = await orderOf(q.terms_hash);
            return v.status === 2 ? v : null;
          },
          30_000,
          250,
        );
        check(o.manifestHash === d.manifest_hash, "on-chain manifestHash != delivered manifest");
        const st = await tool("keyframe_status", { order_id: paidS.order_id, access_token: paidS.access_token });
        check(!st.isError && st.sc.envelope === "IN REVIEW", `envelope ${st.sc?.envelope}`);
        return `deliver tx ${d.tx}; Delivered with manifest ${d.manifest_hash}; keyframe_status → IN REVIEW`;
      },
    );
    await step(
      "12.3",
      "keyframe_review accept: typed data (stage 1) → buyer signs → relayed decideBySig (stage 2)",
      async () => {
        const s1 = await tool("keyframe_review", {
          order_id: paidS.order_id,
          access_token: paidS.access_token,
          decision: "accept",
        });
        check(!s1.isError && s1.sc.stage === "sign" && s1.sc.typed_data, s1.text.slice(0, 300));
        const td = s1.sc.typed_data;
        check(
          td.primaryType === "Decision" &&
            isAddressEqual(td.domain.verifyingContract, FACTORY) &&
            td.message.termsHash === q.terms_hash &&
            td.message.accept === true,
          `typed data ${JSON.stringify(td).slice(0, 300)}`,
        );
        const { EIP712Domain: _drop, ...types } = td.types;
        sig = await buyer.signTypedData({
          domain: td.domain,
          types,
          primaryType: td.primaryType,
          message: { ...td.message, deadline: BigInt(td.message.deadline) },
        });
        const s2 = await tool("keyframe_review", {
          order_id: paidS.order_id,
          access_token: paidS.access_token,
          decision: "accept",
          signature: sig,
          sig_deadline: s1.sc.sig_deadline,
        });
        check(
          !s2.isError && s2.sc.stage === "submitted" && isAddressEqual(s2.sc.signer, buyer.address),
          s2.text.slice(0, 300),
        );
        report.txs.studio_decide = s2.sc.tx;
        return `signer ${s2.sc.signer}; decideBySig tx ${s2.sc.tx}; status ${s2.sc.status}`;
      },
    );
    await step(
      "12.4",
      "release after accept (seller paid payoutAt(deliveredAt)); keyframe_verify delivery → verified",
      async () => {
        let o = await orderOf(q.terms_hash);
        if (o.status !== 3) {
          await waitFor(
            "Released after accept",
            async () => (await orderOf(q.terms_hash)).status === 3,
            20_000,
            250,
          ).catch(async () => {
            observe("Studio release did not follow decideBySig within 20 s; ran the keeper");
            await scheduled();
            await waitFor("Released", async () => (await orderOf(q.terms_hash)).status === 3, 30_000, 250);
          });
          o = await orderOf(q.terms_hash);
        }
        check(
          o.accepted === true && o.toSeller === BigInt(q.terms.amount) && o.toBuyer === 0n,
          `accepted ${o.accepted} toSeller ${o.toSeller}`,
        );
        check((await usdcOf(seller.address)) - s0 === BigInt(q.terms.amount), "seller balance delta");
        check(o.key.toLowerCase() === kChainOf(q.quote_id), "key != K_chain");
        const ev = await pub.getContractEvents({
          address: FACTORY,
          abi: factoryAbi,
          eventName: "Released",
          args: { termsHash: q.terms_hash },
          fromBlock: BigInt(FORK_BLOCK + 1),
        });
        report.txs.studio_release = ev[0]?.transactionHash ?? null;
        const v = await tool("keyframe_verify", { mode: "delivery", paid_response: paidS });
        check(
          !v.isError && v.sc.verdict === "verified",
          `verdict ${v.sc?.verdict} ${JSON.stringify(v.sc?.checks?.filter((c) => c.status !== "pass"))}`,
        );
        return `Released (accepted), seller +${o.toSeller}; release tx ${report.txs.studio_release}; delivery verified (${v.sc.delivery.media.width}x${v.sc.delivery.media.height}, ${v.sc.delivery.media.duration_ms} ms)`;
      },
    );
  });

  // ============================================================================== 6. refund path
  await scenario("6 refund path", async () => {
    const qs = {};
    const paid = {};
    let buyerBefore;
    let offsetMs = 0;
    await step("6.1", "two short-deadline quotes (deadline_minutes 5) rendered to final", async () => {
      for (const k of ["C", "D"]) {
        const r = await tool("keyframe_quote", quoteArgs(`Refund ${k}`, { deadline_minutes: 5 }));
        check(!r.isError, r.text.slice(0, 300));
        qs[k] = r.sc.quote_id;
      }
      for (const k of ["C", "D"]) {
        await pollFinal(qs[k]);
        qs[`${k}q`] = await (await fetch(`${api}/v1/quotes/${qs[k]}`)).json();
      }
      return `C ${qs.C} deadline ${qs.Cq.deadline}; D ${qs.D} deadline ${qs.Dq.deadline} (now ${Math.floor(Date.now() / 1000)})`;
    });
    await step(
      "6.2",
      "release blocked (fault injected on the API's RPC), both paid via x402 → funded but not released",
      async () => {
        proxyState.blockRelease = true;
        buyerBefore = await usdcOf(buyer.address);
        for (const k of ["C", "D"]) {
          const c = await tool("keyframe_commission", { quote_id: qs[k] });
          check(!c.isError, c.text.slice(0, 300));
          const p = await payX402(c.sc, buyer);
          check(p.status === 200, `${k}: paid request ${p.status} ${p.text.slice(0, 200)}`);
          paid[k] = p.body;
          report.txs[`refund_${k}_funding`] = p.body.funding_tx;
        }
        await sleep(4_000);
        for (const k of ["C", "D"]) {
          const o = await orderOf(qs[`${k}q`].terms_hash);
          check(o.status === 1, `${k} is ${o.statusName}, expected Open`);
        }
        check(proxyState.blocked >= 2, `only ${proxyState.blocked} release calls were blocked`);
        const after = await usdcOf(buyer.address);
        return `C and D Open on-chain; ${proxyState.blocked} release attempt(s) blocked; buyer paid ${buyerBefore - after}`;
      },
    );
    await step(
      "6.3",
      "anvil clock advanced past both deadlines (release unblocked: it can only fail TooLate now)",
      async () => {
        const target = Math.max(qs.Cq.deadline, qs.Dq.deadline) + 120;
        await rpc("evm_setNextBlockTimestamp", [target]);
        await rpc("evm_mine");
        const now = await chainNow();
        offsetMs = (now - Math.floor(Date.now() / 1000)) * 1000;
        proxyState.blockRelease = false;
        report.timings.clock_advanced_s = sec(offsetMs);
        const count = await pub.readContract({
          address: FACTORY,
          abi: factoryAbi,
          functionName: "refundableCount",
          args: [50n],
        });
        check(count === 2n, `refundableCount ${count}`);
        return `chain time ${now} (+${Math.round(offsetMs / 1000)} s vs wall clock); refundableCount(50) = ${count}`;
      },
    );
    await step(
      "6.4",
      "keyframe_refund on D with the plugin's wall clock still before the deadline → refuses (no proposal)",
      async () => {
        const r = await tool("keyframe_refund", { action: "refund", quote_id: qs.D });
        check(r.isError === true && !r.sc?.[PROPOSAL] && /Not refundable yet/.test(r.text), r.text.slice(0, 300));
        return "isError: Not refundable yet (plugin clock = wall clock)";
      },
    );
    await step(
      "6.5",
      "keyframe_refund on D (plugin clock = fork clock) → refund(T) proposal; buyer executes it → Refunded",
      async () => {
        const r = await tool("keyframe_refund", { action: "refund", quote_id: qs.D }, { clockOffsetMs: offsetMs });
        check(!r.isError, r.text.slice(0, 400));
        const p = r.sc[PROPOSAL];
        check(
          p.kind === "evm" && isAddressEqual(p.transaction.to, FACTORY) && p.transaction.value === "0",
          JSON.stringify(p),
        );
        const d = decodeFunctionData({ abi: factoryAbi, data: p.transaction.data });
        check(d.functionName === "refund", `calldata is ${d.functionName}`);
        const T = qs.Dq.terms;
        const t = d.args[0];
        check(
          isAddressEqual(t.buyer, T.buyer) &&
            t.amount === BigInt(T.amount) &&
            t.salt === T.salt &&
            t.contentHash === T.contentHash,
          "refund(T) is not this deal",
        );
        const hashed = await pub.readContract({
          address: FACTORY,
          abi: factoryAbi,
          functionName: "hashTerms",
          args: [t],
        });
        check(hashed === qs.Dq.terms_hash, "factory.hashTerms(T) != quote terms_hash");
        const { hash, receipt } = await sendFromBuyer(buyerWallet, p.transaction);
        check(receipt.status === "success", "refund reverted");
        report.txs.refund_D_buyer_refund = hash;
        const o = await orderOf(qs.Dq.terms_hash);
        check(
          o.status === 4 && o.toBuyer === BigInt(T.amount) && o.toSeller === 0n,
          `D ${o.statusName} toBuyer ${o.toBuyer}`,
        );
        const v = await tool("keyframe_verify", { mode: "funding", quote_id: qs.D }, { clockOffsetMs: offsetMs });
        check(!v.isError && v.sc.envelope === "RETURNED", `verify envelope ${v.sc?.envelope}`);
        return `tx ${hash}; D Refunded, ${o.toBuyer} back to the buyer; keyframe_verify funding → RETURNED`;
      },
    );
    await step(
      "6.6",
      "API keeper cron (scheduled handler) refunds C (refundExpired) and syncs both orders to returned",
      async () => {
        const t1 = await scheduled();
        const o = await waitFor(
          "C Refunded",
          async () => {
            const v = await orderOf(qs.Cq.terms_hash);
            return v.status === 4 ? v : null;
          },
          60_000,
          250,
        );
        const ev = await pub.getContractEvents({
          address: FACTORY,
          abi: factoryAbi,
          eventName: "Refunded",
          args: { termsHash: qs.Cq.terms_hash },
          fromBlock: BigInt(FORK_BLOCK + 1),
        });
        report.txs.refund_C_keeper = ev[0]?.transactionHash ?? null;
        const rtx = ev[0] ? await pub.getTransaction({ hash: ev[0].transactionHash }) : null;
        const how = rtx ? decodeFunctionData({ abi: factoryAbi, data: rtx.input }).functionName : "?";
        check(rtx && isAddressEqual(rtx.from, relayer.address), "C was not refunded by the API's keeper key");
        const t2 = await scheduled();
        const statuses = {};
        for (const k of ["C", "D"]) {
          const ord = await waitFor(
            `API order ${k} returned`,
            async () => {
              const j = await (await fetch(`${api}/v1/orders/${paid[k].order_id}`)).json();
              return j.status === "returned" ? j : null;
            },
            30_000,
            500,
          );
          statuses[k] = ord.status;
        }
        check(o.toBuyer === BigInt(qs.Cq.terms.amount) && o.toSeller === 0n, `C toBuyer ${o.toBuyer}`);
        return `tick1 refund_expired_sent=${t1.refund_expired_sent} (C via ${how}, tx ${report.txs.refund_C_keeper}); tick2 orders_advanced=${t2.orders_advanced}; API C=${statuses.C} D=${statuses.D}`;
      },
    );
    await step(
      "6.7",
      "buyer made whole: USDC balance equals the balance before both refund-path payments",
      async () => {
        const after = await usdcOf(buyer.address);
        check(after === buyerBefore, `buyer ${after} vs ${buyerBefore}`);
        for (const k of ["C", "D"]) {
          const e = qs[`${k}q`].escrow;
          check((await usdcOf(e)) === 0n, `${k} escrow still holds USDC`);
          check(
            (await pub.getCode({ address: e }))?.toLowerCase() === cloneCode(VAULT_IMPL),
            `${k} escrow is not the clone`,
          );
        }
        const st = await tool(
          "keyframe_status",
          { order_id: paid.C.order_id, access_token: paid.C.access_token },
          { clockOffsetMs: offsetMs },
        );
        check(!st.isError && st.sc.envelope === "RETURNED", `status envelope ${st.sc?.envelope}`);
        const views = {};
        for (const k of ["C", "D"])
          views[k] = await (await fetch(`${api}/v1/orders/${paid[k].order_id}?token=${paid[k].access_token}`)).json();
        if (views.C.refund_tx === null || views.D.refund_tx === null)
          observe(
            `API order view after a refund it did not send itself: C (refundExpired) refund_tx=${views.C.refund_tx}, D (buyer refund) refund_tx=${views.D.refund_tx}; to_buyer C=${views.C.to_buyer} D=${views.D.to_buyer}`,
          );
        return `buyer back to ${after} atomic USDC; keyframe_status C → RETURNED; API to_buyer C=${views.C.to_buyer} D=${views.D.to_buyer}`;
      },
    );
  });

  return finish(tStart);
}

// Raw keys of the run's fresh accounts, only for child processes (forge, wrangler secrets); never logged.
const rawKeys = new Map();
const secretKeyOf = (account) => rawKeys.get(account.address);

function finish(tStart) {
  report.finished_at = new Date().toISOString();
  report.timings.total_s = sec(Date.now() - tStart);
  report.plugin_calls = pluginCalls;
  report.proxy = { ...proxyState };
  const failed = report.steps.filter((s) => s.status === "fail");
  report.result = failed.length === 0 ? "PASS" : "FAIL";
  writeFileSync(join(RUN_DIR, "report.json"), redact(JSON.stringify(report, big, 2)));
  log(
    `\n${report.result}: ${report.steps.length - failed.length}/${report.steps.length} steps passed; report ${join(RUN_DIR, "report.json")}`,
  );
  return failed.length === 0;
}

async function cleanup() {
  for (const c of [...children].reverse()) await stopProc(c, c.name === "worker" ? 30_000 : 8_000);
  for (const s of servers) s.close?.();
  for (const f of secretFiles) rmSync(f, { force: true });
  // The Relayer DO and D1 state hold no keys, but the run's state dir is not needed after the report.
  if (process.env.KEEP_STATE !== "1") rmSync(STATE, { recursive: true, force: true });
  // Scan every file left in the run directory for any leaked secret (keys, KMASTER, tokens, the fork URL).
  const leaks = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size < 64 * 1024 * 1024) {
        const text = readFileSync(p, "latin1");
        for (const s of secrets) if (s.length >= 16 && text.includes(s)) leaks.push(p.slice(RUN_DIR.length + 1));
      }
    }
  };
  walk(RUN_DIR);
  writeFileSync(
    join(RUN_DIR, "leak-scan.json"),
    JSON.stringify({ secrets_checked: [...secrets].filter((x) => x.length >= 16).length, leaks: [...new Set(leaks)] }),
  );
  if (leaks.length > 0) console.error(`SECRET LEAK in ${[...new Set(leaks)].join(", ")}`);
  return leaks.length === 0;
}

let ok = false;
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
try {
  ok = await main();
} catch (e) {
  log(`driver crashed: ${e?.stack ?? e}`);
  finish(Date.now());
} finally {
  const clean = await cleanup();
  process.exit(ok && clean ? 0 : 1);
}
