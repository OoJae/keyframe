#!/usr/bin/env node
// Local smoke test of the real Worker bundle in workerd (`wrangler dev --local`): D1 migrations, KV storage,
// Cron, the internal render-worker API and the deterministic 402. When Foundry is installed it also starts a
// throwaway anvil (chain id 8453, no fork), deploys the factory + a USDC mock, and pays the 402 with a real x402
// client, so the relayer Durable Object, viem and the x402 verifier run inside workerd against a real EVM.
// Offline: a local HTTP server serves the OFAC list; secrets are random per run and never printed.
//   node scripts/smoke-local.mjs [--no-chain]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { webcrypto as crypto, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { english, generateMnemonic, generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const STATE = join(ROOT, ".wrangler/smoke");
const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const sha256 = async (b) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const has = (bin) => spawnSync("which", [bin]).status === 0;
const withChain = !process.argv.includes("--no-chain") && has("anvil") && has("forge");

/** Throwaway anvil + factory + USDC mock (test/e2e build). Keys are random per run and never printed. */
async function startChain() {
  execFileSync("forge", ["build", "--root", join(ROOT, "test/e2e")], { stdio: "ignore" });
  const art = (file, name) => {
    const j = JSON.parse(readFileSync(join(ROOT, "test/e2e/out", file, `${name}.json`), "utf8"));
    return { abi: j.abi, bytecode: j.bytecode.object };
  };
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const mnemonic = generateMnemonic(english);
  const proc = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--mnemonic", mnemonic, "--silent"], {
    stdio: "ignore",
  });
  const chain = {
    id: 8453,
    name: "local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await pub.getChainId()) === 8453) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const operator = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const seller = mnemonicToAccount(mnemonic, { addressIndex: 2 }).address;
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
  const mock = art("E2E.sol", "MockUSDCWithVRS");
  const fac = art("KeyframeEscrowFactory.sol", "KeyframeEscrowFactory");
  const usdc = getAddress(
    (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract(mock) })).contractAddress,
  );
  const factory = getAddress(
    (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ ...fac, args: [usdc, seller] }) }))
      .contractAddress,
  );
  const buyer = privateKeyToAccount(generatePrivateKey());
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: usdc,
      abi: mock.abi,
      functionName: "mint",
      args: [buyer.address, 50_000_000n],
    }),
  });
  const balanceOf = (a) => pub.readContract({ address: usdc, abi: mock.abi, functionName: "balanceOf", args: [a] });
  const orderOf = (h) => pub.readContract({ address: factory, abi: fac.abi, functionName: "order", args: [h] });
  return {
    rpc,
    usdc,
    factory,
    seller,
    buyer,
    operatorKey: hex(operator.getHdKey().privateKey),
    balanceOf,
    orderOf,
    receipt: (hash) => pub.getTransactionReceipt({ hash }),
    stop: () => proc.kill(),
  };
}

// --- local OFAC list
const ofac = Array.from({ length: 20 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
const listServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(ofac));
});
const listPort = await freePort();
await new Promise((r) => listServer.listen(listPort, "127.0.0.1", r));

// --- ephemeral config (random secrets; relayer key is random and unfunded; factory is a dummy address)
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
const chain = withChain ? await startChain() : null;
const port = await freePort();
const base = `http://localhost:${port}`;
const workerToken = randomBytes(32).toString("base64url");
const envFile = join(STATE, "env");
writeFileSync(
  envFile,
  [
    `KMASTER=${randomBytes(32).toString("hex")}`,
    `ACCESS_SECRET=${randomBytes(32).toString("hex")}`,
    `WORKER_TOKEN=${workerToken}`,
    `RELAYER_PRIVATE_KEY=${chain ? chain.operatorKey : hex(randomBytes(32))}`,
  ].join("\n"),
  { mode: 0o600 },
);
const vars = {
  PUBLIC_BASE_URL: base,
  FACTORY_ADDRESS: chain ? chain.factory : hex(randomBytes(20)),
  SELLER_ADDRESS: chain ? chain.seller : hex(randomBytes(20)),
  RPC_URL: chain ? chain.rpc : "http://127.0.0.1:9",
  OFAC_LIST_URL: `http://127.0.0.1:${listPort}/sanctioned_addresses_ETH.json`,
  ...(chain ? { USDC_ADDRESS: chain.usdc } : {}),
};

const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "keyframe", "--local", "--persist-to", STATE], {
  cwd: ROOT,
  encoding: "utf8",
  env: { ...process.env, CI: "1" },
});
check("D1 migrations apply (local)", migrate.status === 0, migrate.status === 0 ? "" : migrate.stderr.slice(-300));

const dev = spawn(
  WRANGLER,
  [
    "dev",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    STATE,
    "--env-file",
    envFile,
    "--test-scheduled",
    "--show-interactive-dev-session=false",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
);
let devLog = "";
dev.stdout.on("data", (d) => {
  devLog += d;
});
dev.stderr.on("data", (d) => {
  devLog += d;
});

const auth = { authorization: `Bearer ${workerToken}`, "x-worker-id": "smoke" };
const call = (path, init = {}) => fetch(`${base}${path}`, init);

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await call("/health")).status === 200;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("wrangler dev serves /health", up);
  if (!up) throw new Error(devLog.slice(-2000));

  const refresh = await (await call("/internal/sanctions/refresh", { method: "POST", headers: auth })).json();
  check("OFAC list refresh via internal API", refresh.ok === true && refresh.count === 20, JSON.stringify(refresh));
  const health = await (await call("/health")).json();
  check(
    "health ok (configured, sanctions fresh, KV storage)",
    health.ok && health.storage === "kv",
    JSON.stringify({ ok: health.ok, storage: health.storage }),
  );

  const styles = await (await call("/v1/styles")).json();
  check("catalog", styles.formats.length === 7);

  const buyer = chain ? chain.buyer.address : hex(randomBytes(20));
  const quote = () =>
    call("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        buyer,
        format: "countdown",
        rights_confirmed: true,
        params: { style: "tminus", label: "Mainnet", target: new Date(Date.now() + 86_400_000).toISOString() },
      }),
    });
  // no render worker has polled yet: Instant quotes fail fast instead of leaving a draft nothing will render
  const offline = await quote();
  check(
    "no render worker yet → 503 studio_offline",
    offline.status === 503 && (await offline.json()).error === "studio_offline",
  );
  const idle = await call("/internal/jobs/claim", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ worker_id: "smoke" }),
  });
  check("render worker polls (204, now online)", idle.status === 204);
  const qres = await quote();
  const draft = await qres.json();
  check("POST /v1/quotes → 201 draft", qres.status === 201 && draft.status === "draft", `${qres.status}`);
  const notReady = await call(`/v1/orders/${draft.quote_id}`, { method: "POST" });
  check("draft quote answers 425 without a 402", notReady.status === 425 && !notReady.headers.get("payment-required"));

  // --- play the render worker
  const claim = await call("/internal/jobs/claim", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ worker_id: "smoke" }),
  });
  const job = await claim.json();
  check("worker claims the render job", claim.status === 200 && job.kind === "instant_render");
  const put = async (path, body, type) =>
    (await call(path, { method: "PUT", headers: { ...auth, "content-type": type }, body })).status;
  const mp4 = new Uint8Array(readFileSync(join(ROOT, "test/fixtures/countdown-8s-9x16.m4v")));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const key = await crypto.subtle.importKey("raw", Buffer.from(job.kfc1.k_file.slice(2), "hex"), "AES-GCM", false, [
    "encrypt",
  ]);
  const salt = Buffer.from(job.kfc1.salt.slice(2), "hex");
  const iv = new Uint8Array(12);
  const aad = Buffer.concat([Buffer.from("KFC1"), salt, Buffer.alloc(8), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, mp4));
  const manifest = {
    v: 1,
    alg: "KFC1",
    salt: job.kfc1.salt,
    chunkSize: 1048560,
    size: mp4.byteLength,
    chunks: 1,
    plaintextSha256: await sha256(mp4),
    ciphertext: [await sha256(ct)],
    plaintext: [await sha256(mp4)],
    media: { mime: "video/mp4", width: 1080, height: 1920, durationMs: 8000, fps: 30 },
  };
  const uploads = [
    await put(job.upload.still, png, "image/png"),
    await put(job.upload.preview, mp4, "video/mp4"),
    await put(job.upload.manifest, JSON.stringify(manifest), "application/json"),
    await put(job.upload.chunk.replace("{i}", "0"), ct, "application/octet-stream"),
  ];
  check(
    "uploads accepted (still, preview, manifest, chunk)",
    uploads.every((s) => s === 200),
    uploads.join(","),
  );
  const done = await call(`/internal/jobs/${job.job_id}/done`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      template: { id: "countdown", version: "1.0.0", hash: `0x${"ab".repeat(32)}` },
      renderer: { name: "hyperframes", version: "0.8.140" },
    }),
  });
  const doneBody = await done.json();
  check(
    "done → quote final (self-verified from KV)",
    done.status === 200 && doneBody.status === "final",
    JSON.stringify(doneBody).slice(0, 160),
  );
  const final = await (await call(`/v1/quotes/${draft.quote_id}`)).json();
  check("final quote: contentHash = manifestHash", final.terms.contentHash === final.content.manifest_hash);
  const manifestServed = await call(new URL(final.content.manifest_url).pathname);
  check(
    "manifest served at the frozen layout",
    (await sha256(new Uint8Array(await manifestServed.arrayBuffer()))) === final.content.manifest_hash,
  );

  // --- the 402
  const variants = [
    { method: "POST" },
    { method: "GET" },
    { method: "PUT", body: "x" },
    { method: "GET", headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } },
  ];
  const headers = [];
  for (const v of variants) {
    const r = await call(`/v1/orders/${draft.quote_id}`, v);
    headers.push(`${r.status}|${r.headers.get("payment-required")}|${await r.text()}`);
  }
  check(
    "402 byte-identical across POST/GET/PUT/browser",
    new Set(headers).size === 1 && headers[0].startsWith("402|"),
    `${new Set(headers).size} distinct`,
  );
  const pr = JSON.parse(Buffer.from(headers[0].split("|")[1], "base64").toString());
  check(
    "402 pays exactly E the quoted amount (x402 v2, exact, USDC)",
    pr.x402Version === 2 &&
      pr.accepts.length === 1 &&
      pr.accepts[0].payTo === final.escrow &&
      pr.accepts[0].amount === final.price.atomic &&
      pr.accepts[0].network === "eip155:8453",
  );
  check("resource URL is canonical", pr.resource.url === `${base}/v1/orders/${draft.quote_id}`);

  if (chain) {
    // --- pay with a real x402 client; settlement and release run in workerd through the relayer DO
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: chain.buyer });
    client.setSpendControls(false);
    const x = new x402HTTPClient(client);
    const unpaid = await call(`/v1/orders/${draft.quote_id}`, { method: "POST" });
    const required = x.getPaymentRequiredResponse((n) => unpaid.headers.get(n), await unpaid.json());
    const payHeaders = x.encodePaymentSignatureHeader(await x.createPaymentPayload(required));
    const t0 = Date.now();
    const paid = await call(`/v1/orders/${draft.quote_id}`, { method: "POST", headers: payHeaders });
    const ms = Date.now() - t0;
    const body = await paid.json();
    check(
      "paid → 200 with the frozen paid body",
      paid.status === 200 && body.next === "keyframe_verify" && body.escrow === final.escrow,
      `${paid.status} ${ms} ms`,
    );
    const fundingReceipt = await chain.receipt(body.funding_tx);
    check(
      "funding tx mined: fundWithAuthorization on the factory",
      body.funding === "confirmed" &&
        fundingReceipt.status === "success" &&
        fundingReceipt.to?.toLowerCase() === chain.factory.toLowerCase(),
    );
    const replay = await call(`/v1/orders/${draft.quote_id}`, { method: "GET", headers: payHeaders });
    check(
      "replay of the same authorization is byte-identical",
      replay.status === 200 && JSON.stringify(await replay.json()) === JSON.stringify(body),
    );
    let status = "";
    for (let i = 0; i < 40 && status !== "key_published"; i++) {
      status = (await (await call(`/v1/orders/${body.order_id}`)).json()).status;
      if (status !== "key_published") await new Promise((r) => setTimeout(r, 250));
    }
    check("release sent by the relayer DO (order key_published)", status === "key_published", status);
    const view = await chain.orderOf(final.terms_hash);
    check("factory order(h): Released, seller paid the full amount", view.status === 3 && view.toSeller === 1_000_000n);
    check("seller USDC balance", (await chain.balanceOf(chain.seller)) === 1_000_000n);
  }

  const cron = await call("/__scheduled?cron=*+*+*+*+*");
  check("cron trigger runs the keeper", cron.status === 200);
  const stats = await (await call("/v1/stats")).json();
  check("stats", stats.quotes === 1);
} catch (e) {
  check("smoke run", false, e instanceof Error ? e.message.slice(0, 500) : String(e));
} finally {
  dev.kill("SIGTERM");
  listServer.close();
  chain?.stop();
}
const errors = devLog.split("\n").filter((l) => /"level":"error"|Uncaught|Illegal invocation/.test(l));
check("no error-level logs from the Worker", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 400));
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
