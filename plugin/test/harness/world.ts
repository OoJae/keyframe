// A deterministic, in-memory Keyframe backend + Base chain + file host for tests. It speaks the frozen wire
// formats (§5, §7) using the real protocol code, so the plugin is exercised end to end: real Terms hashing, real
// CREATE2 escrows, real 402s, real KFC1 ciphertext of a real MP4, real EIP-712/EIP-191 signatures.
// Adversarial tests mutate its records through hooks to impersonate a compromised or broken backend.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  pad,
  toHex,
  verifyMessage,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPaymentRequiredV1,
  buildPaymentRequiredV2,
  deriveKBuyer,
  deriveKChain,
  encryptKfc1,
  erc20Abi,
  escrowOf,
  hashTerms,
  keyframeFactoryAbi,
  keyHashOf,
  newOrderId,
  newQuoteId,
  saltOf,
  sha256Hex,
  specHash,
  type Terms,
  termsToJson,
  USDC,
  vaultImplOf,
} from "../../src/protocol/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MP4 = new Uint8Array(readFileSync(path.join(here, "../fixtures/sting-1080x1920-6s.m4v")));

export const HOSTS = {
  api: "https://api.kf.test",
  files: "https://files.kf.test",
  rpc1: "https://rpc1.kf.test",
  ipfs: "https://ipfs.kf.test",
  // A path "secret" that must never be echoed by the plugin.
  rpc2: "https://rpc2.kf.test/v2/KF-SECRET-MARKER-9f8e7d",
} as const;

const addr = (label: string): Address => getAddress(`0x${keccak256(toHex(label)).slice(-40)}`);

// Test-only keys (public, derived from labels). Never real funds.
export const BUYER_KEY = keccak256(toHex("keyframe-test-buyer-key"));
export const BUYER = privateKeyToAccount(BUYER_KEY);
export const STRANGER = privateKeyToAccount(keccak256(toHex("keyframe-test-stranger-key")));
export const FACTORY = addr("keyframe-test-factory");
export const VAULT = vaultImplOf(FACTORY);
export const SELLER = addr("keyframe-test-seller");
export const OPERATOR = addr("keyframe-test-operator");
export const ATTACKER = addr("keyframe-test-attacker");
export const OTHER_FACTORY = addr("keyframe-test-other-factory");
const KMASTER = new Uint8Array(32).fill(7);
export const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    KEYFRAME_API_BASE: HOSTS.api,
    KEYFRAME_FILES_BASE: HOSTS.files,
    KEYFRAME_RPC_URLS: `${HOSTS.rpc1},${HOSTS.rpc2}`,
    KEYFRAME_IPFS_GATEWAY: "off",
    KEYFRAME_FACTORIES: JSON.stringify([{ address: FACTORY, vaultImpl: VAULT, status: "active" }]),
    KEYFRAME_SELLERS: SELLER,
    KEYFRAME_OPERATORS: OPERATOR,
    KEYFRAME_MAX_AMOUNT: "50000000",
    KEYFRAME_PRIMARY_RAIL: "x402",
    KEYFRAME_7702_POLICY: "direct-first",
    KEYFRAME_MAINTENANCE: "0",
    ...overrides,
  };
}

type OrderView = {
  status: number;
  buyer: Address;
  deadline: bigint;
  reviewWindow: number;
  openedAt: bigint;
  deliveredAt: bigint;
  finalAt: bigint;
  accepted: boolean;
  key: Hex;
  manifestHash: Hex;
  toSeller: bigint;
  toBuyer: bigint;
};

export type QuoteRecord = {
  quote: Record<string, unknown>;
  terms: Terms;
  termsHash: Hex;
  escrow: Address;
  kChain: Hex;
  kBuyer: Hex;
  manifestHash: Hex;
  chunks: Uint8Array[];
  plaintext: Uint8Array;
  orderId: string;
  accessToken: string;
  draftPolls: number;
  /** 402 payee/amount actually served (defaults: quote.escrow / terms.amount). */
  payTo?: Address;
  amount?: string;
  /** Studio change request as the API's order view reports it (`changes`), set by a "changes" submit. */
  changes?: Record<string, unknown>;
};

export type Hooks = {
  // biome-ignore lint/suspicious/noExplicitAny: adversarial tests rewrite arbitrary fields
  quote?: (q: Record<string, any>, rec: QuoteRecord) => void;
  payment?: (wire: { status: number; headers: Record<string, string>; body: string }, rec: QuoteRecord) => void;
  rpc?: (host: string, method: string, params: unknown[], result: unknown) => unknown;
  typedData?: (td: Record<string, unknown>, rec: QuoteRecord) => Record<string, unknown>;
  siwe?: (message: string) => string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

export class World {
  quotes = new Map<string, QuoteRecord>();
  byOrder = new Map<string, QuoteRecord>();
  orders = new Map<string, OrderView>();
  codes = new Map<string, Hex>();
  eth = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  tokens = new Map<string, bigint>();
  receipts = new Map<string, unknown>();
  files = new Map<string, Uint8Array>();
  /** Mirror the next quotes' ciphertext to the IPFS gateway host and publish content.ipfs_cid. */
  ipfs = false;
  delays = new Map<string, number>();
  down = new Set<string>();
  hooks: Hooks = {};
  wire: "v1" | "v2" = "v2";
  draftFirst = 0;
  /** Absolute deadline for the next quotes (tests of refund windows); default: from deadline_minutes. */
  deadlineAt: number | undefined;
  /** Plaintext padding so masters span several KFC1 chunks (default: 3 chunks). */
  padTo = 2_300_000;
  log: { method: string; url: string }[] = [];
  styles: unknown = {
    formats: [
      { id: "launch_sting", tier: "instant", title: "Launch Sting", price_usdc: { "6": "4.00", "10": "7.00" } },
      { id: "countdown", tier: "instant", title: "Countdown", price_usdc: { "8": "1.00" } },
      { id: "studio_sting", tier: "studio", title: "Studio Sting", price_usdc: { any: "25.00" } },
    ],
    studio: { seller: SELLER },
  };

  constructor() {
    this.eth.set(BUYER.address.toLowerCase(), 10n ** 16n);
    this.usdc.set(BUYER.address.toLowerCase(), 100_000_000n);
  }

  setWallet(a: Address, w: { code?: Hex; eth?: bigint; usdc?: bigint }) {
    if (w.code !== undefined) this.codes.set(a.toLowerCase(), w.code);
    if (w.eth !== undefined) this.eth.set(a.toLowerCase(), w.eth);
    if (w.usdc !== undefined) this.usdc.set(a.toLowerCase(), w.usdc);
  }

  // ---------- backend behaviour ----------

  async createQuote(body: Record<string, unknown>): Promise<QuoteRecord> {
    const qid = newQuoteId();
    const params = (body.params ?? {}) as Record<string, unknown>;
    const studio = body.format === "studio";
    const format = studio ? String(params.deliverable) : String(body.format);
    const durationS = format === "countdown" ? 8 : Number(params.duration_s ?? 6);
    const amount = studio
      ? format === "studio_spot"
        ? 50_000_000n
        : 25_000_000n
      : format === "countdown"
        ? 1_000_000n
        : durationS === 10
          ? 7_000_000n
          : 4_000_000n;
    const rw = studio ? 86_400 : 0;
    const deadline = this.deadlineAt ?? now() + (studio ? 72 * 3600 : Number(body.deadline_minutes ?? 30) * 60 + 300);
    const delivery = (body.delivery as string | undefined) ?? (format === "portfolio_pulse" ? "private" : "public");
    const kChain = await deriveKChain(KMASTER, qid);
    const kBuyer = delivery === "private" ? await deriveKBuyer(KMASTER, qid) : ZERO32;
    const still = new TextEncoder().encode(`RIFF....WEBPVP8 still for ${qid}`);
    const stillSha = await sha256Hex(still);
    this.files.set(`/p/${qid}.webp`, still);
    const intParams: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isSafeInteger(v)))
        intParams[k] = v;
    }
    const spec = {
      v: 1,
      studio: SELLER,
      tier: studio ? "studio" : "instant",
      format,
      style: String(params.style ?? "studio"),
      aspect: String(body.aspect ?? "9:16"),
      durationS,
      params: intParams,
      template: { id: format, version: "1.0.0", hash: keccak256(toHex(`template:${format}`)) },
      renderer: { name: "hyperframes", version: "0.0.0-test" },
      keyframe: studio ? null : { stillSha256: stillSha, atMs: 3400 },
      delivery,
      kBuyerHash: delivery === "private" ? await sha256Hex(Uint8Array.from(Buffer.from(kBuyer.slice(2), "hex"))) : null,
      dataSnapshotSha256: null,
    };
    let manifestHash = ZERO32;
    let ipfsCid: string | null = null;
    let chunks: Uint8Array[] = [];
    let plaintext = new Uint8Array(0);
    if (!studio) {
      plaintext = new Uint8Array(Math.max(MP4.byteLength, this.padTo));
      plaintext.set(MP4);
      for (let i = MP4.byteLength; i < plaintext.byteLength; i++) plaintext[i] = i % 251;
      const enc = await encryptKfc1(plaintext, {
        kChain,
        kBuyer,
        salt: saltOf(qid),
        media: { mime: "video/mp4", width: 1080, height: 1920, durationMs: 6000, fps: 30 },
      });
      manifestHash = enc.manifestHash;
      chunks = enc.chunks;
      const manifestBytes = new TextEncoder().encode(JSON.stringify(enc.manifest));
      this.files.set(`/c/${manifestHash}/manifest.json`, manifestBytes);
      for (const [i, c] of enc.chunks.entries()) this.files.set(`/c/${manifestHash}/${i}.bin`, c);
      if (this.ipfs) {
        ipfsCid = `b${keccak256(manifestHash)
          .slice(2)
          .replace(/[^a-z2-7]/g, "a")
          .padEnd(58, "a")
          .slice(0, 58)}`;
        this.files.set(`ipfs:/ipfs/${ipfsCid}/manifest.json`, manifestBytes);
        for (const [i, c] of enc.chunks.entries()) this.files.set(`ipfs:/ipfs/${ipfsCid}/${i}.bin`, c);
      }
    }
    const terms: Terms = {
      buyer: getAddress(String(body.buyer)),
      seller: SELLER,
      operator: OPERATOR,
      token: USDC,
      amount,
      dueAt: 0,
      deadline,
      reviewWindow: rw,
      slaFloorBps: 10_000,
      killFeeBps: studio ? 2_000 : 0,
      keyHash: keyHashOf(kChain),
      specHash: await specHash(spec),
      contentHash: manifestHash,
      salt: saltOf(qid),
    };
    const termsHash = hashTerms(terms, FACTORY);
    const escrow = escrowOf(termsHash, FACTORY, VAULT);
    const quote: Record<string, unknown> = {
      v: 1,
      quote_id: qid,
      status: this.draftFirst > 0 ? "draft" : "final",
      tier: spec.tier,
      format: String(body.format),
      buyer: terms.buyer,
      price: { atomic: amount.toString(), usdc: (Number(amount) / 1e6).toFixed(2) },
      eta_s: studio ? 172_800 : 60,
      quote_expires_at: now() + 300,
      deadline,
      factory: FACTORY,
      vault_impl: VAULT,
      terms: termsToJson(terms),
      terms_hash: termsHash,
      escrow,
      spec,
      spec_hash: terms.specHash,
      preview: { still_url: `${HOSTS.files}/p/${qid}.webp`, still_sha256: stillSha, video_url: null },
      content: studio
        ? { manifest_url: null, manifest_hash: null }
        : {
            manifest_url: `${HOSTS.files}/c/${manifestHash}/manifest.json`,
            manifest_hash: manifestHash,
            ...(ipfsCid ? { ipfs_cid: ipfsCid } : {}),
          },
      delivery,
      retry_after_ms: this.draftFirst > 0 ? 1000 : 0,
      disclosures: [
        "Unaudited contracts; orders are capped at 50 USDC.",
        "Buyer and studio wallets in demos belong to the builder.",
      ],
    };
    const rec: QuoteRecord = {
      quote,
      terms,
      termsHash,
      escrow,
      kChain,
      kBuyer,
      manifestHash,
      chunks,
      plaintext,
      orderId: newOrderId(),
      accessToken: `${"A".repeat(20)}${qid.slice(2, 22)}xyz`,
      draftPolls: this.draftFirst,
    };
    this.hooks.quote?.(quote, rec);
    this.quotes.set(qid, rec);
    this.byOrder.set(rec.orderId, rec);
    return rec;
  }

  /** x402 settlement: buyer -> E, register T (contract-as-facilitator). */
  pay(qid: string, opts: { register?: boolean; amount?: bigint } = {}): Hex {
    const rec = this.must(qid);
    const amount = opts.amount ?? rec.terms.amount;
    const e = rec.escrow.toLowerCase();
    this.usdc.set(e, (this.usdc.get(e) ?? 0n) + amount);
    const b = rec.terms.buyer.toLowerCase();
    this.usdc.set(b, (this.usdc.get(b) ?? 0n) - amount);
    if (opts.register !== false) {
      this.orders.set(rec.termsHash, {
        ...this.emptyOrder(),
        status: 1,
        buyer: rec.terms.buyer,
        deadline: BigInt(rec.terms.deadline),
        reviewWindow: rec.terms.reviewWindow,
        openedAt: BigInt(now()),
      });
    }
    const tx = keccak256(toHex(`fund:${qid}:${amount}`));
    this.receipts.set(tx, {
      status: "0x1",
      to: opts.register === false ? USDC : FACTORY,
      logs: [
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, pad(rec.terms.buyer), pad(rec.escrow)],
          data: encodeAbiParameters([{ type: "uint256" }], [amount]),
        },
      ],
    });
    rec.quote.status = "paid";
    return tx;
  }

  release(qid: string, opts: { key?: Hex; manifestHash?: Hex; toSeller?: bigint } = {}) {
    const rec = this.must(qid);
    const o = this.orders.get(rec.termsHash) ?? this.emptyOrder();
    const bal = this.usdc.get(rec.escrow.toLowerCase()) ?? 0n;
    const toSeller = opts.toSeller ?? rec.terms.amount;
    this.orders.set(rec.termsHash, {
      ...o,
      status: 3,
      buyer: rec.terms.buyer,
      deadline: BigInt(rec.terms.deadline),
      finalAt: BigInt(now()),
      key: opts.key ?? rec.kChain,
      manifestHash: opts.manifestHash ?? rec.manifestHash,
      toSeller,
      toBuyer: bal > toSeller ? bal - toSeller : 0n,
    });
    this.usdc.set(rec.escrow.toLowerCase(), 0n);
    this.codes.set(
      rec.escrow.toLowerCase(),
      concat(["0x363d3d373d3d3d363d73", VAULT, "0x5af43d82803e903d91602b57fd5bf3"]),
    );
  }

  deliverStudio(qid: string, opts: { deliveredAt?: number } = {}) {
    const rec = this.must(qid);
    const o = this.orders.get(rec.termsHash) as OrderView;
    this.orders.set(rec.termsHash, {
      ...o,
      status: 2,
      deliveredAt: BigInt(opts.deliveredAt ?? now()),
      manifestHash: keccak256(toHex("studio-file")),
    });
  }

  setOrder(qid: string, patch: Partial<OrderView>) {
    const rec = this.must(qid);
    this.orders.set(rec.termsHash, { ...(this.orders.get(rec.termsHash) ?? this.emptyOrder()), ...patch });
  }

  paidBody(qid: string, fundingTx: Hex) {
    const rec = this.must(qid);
    return {
      v: 1,
      order_id: rec.orderId,
      access_token: rec.accessToken,
      quote_id: qid,
      terms_hash: rec.termsHash,
      escrow: rec.escrow,
      amount: rec.terms.amount.toString(),
      deadline: rec.terms.deadline,
      funding_tx: fundingTx,
      funding: "confirmed",
      k_buyer: rec.kBuyer === ZERO32 ? null : rec.kBuyer,
      status_url: `${HOSTS.api}/v1/orders/${rec.orderId}`,
      next: "keyframe_verify",
    };
  }

  must(qid: string): QuoteRecord {
    const r = this.quotes.get(qid);
    if (!r) throw new Error(`no quote ${qid}`);
    return r;
  }

  private emptyOrder(): OrderView {
    return {
      status: 0,
      buyer: "0x0000000000000000000000000000000000000000",
      deadline: 0n,
      reviewWindow: 0,
      openedAt: 0n,
      deliveredAt: 0n,
      finalAt: 0n,
      accepted: false,
      key: ZERO32,
      manifestHash: ZERO32,
      toSeller: 0n,
      toBuyer: 0n,
    };
  }

  // ---------- HTTP ----------

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.log.push({ method: req.method, url: `${url.origin}${url.pathname}` });
    const delay = this.delays.get(url.host) ?? 0;
    if (delay > 0) await sleep(delay);
    if (this.down.has(url.host)) return new Response("down", { status: 503 });
    if (url.origin === HOSTS.api) return this.api(req, url);
    if (url.origin === HOSTS.files) return this.filesRoute(url);
    if (url.origin === HOSTS.ipfs) return this.filesRoute(url, "ipfs:");
    if (url.host === "rpc1.kf.test" || url.host === "rpc2.kf.test") return this.rpc(req, url.host);
    return new Response("unknown host", { status: 404 });
  }

  private filesRoute(url: URL, prefix = ""): Response {
    const f = this.files.get(`${prefix}${url.pathname}`);
    return f
      ? new Response(f.slice(), { status: 200, headers: { "content-length": String(f.byteLength) } })
      : new Response("nf", { status: 404 });
  }

  private async api(req: Request, url: URL): Promise<Response> {
    const p = url.pathname;
    const body = req.method === "POST" ? await req.text() : "";
    const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (p === "/v1/styles") return json(200, this.styles);
    if (p === "/v1/quotes" && req.method === "POST") return json(201, (await this.createQuote(data)).quote);
    let m = /^\/v1\/quotes\/(q_\w+)$/.exec(p);
    if (m) {
      const rec = this.quotes.get(m[1] as string);
      if (!rec) return json(404, { error: "not_found" });
      if (rec.quote.status === "draft" && --rec.draftPolls <= 0) {
        rec.quote.status = "final";
        rec.quote.retry_after_ms = 0;
      }
      return json(200, rec.quote);
    }
    m = /^\/v1\/orders\/(q_\w+)$/.exec(p);
    if (m) {
      const rec = this.quotes.get(m[1] as string);
      if (!rec) return json(404, { error: "not_found" });
      if (rec.quote.status === "paid")
        return json(409, { error: "already_paid", message: "This quote is already paid; you were not charged." });
      if (rec.quote.status === "expired") return json(410, { error: "expired" });
      const input = {
        url: `${HOSTS.api}/v1/orders/${m[1]}`,
        description: `Order ${m[1]}: pay-on-delivery escrow`,
        amount: rec.amount ?? rec.terms.amount,
        payTo: rec.payTo ?? (rec.quote.escrow as Address),
      };
      const wire = this.wire === "v2" ? buildPaymentRequiredV2(input) : buildPaymentRequiredV1(input);
      this.hooks.payment?.(wire, rec);
      return new Response(wire.body, { status: wire.status, headers: wire.headers });
    }
    m = /^\/v1\/orders\/(o_\w+)$/.exec(p);
    if (m) {
      const rec = this.byOrder.get(m[1] as string);
      if (!rec) return json(404, { error: "not_found" });
      if (rec.quote.delivery === "private" && url.searchParams.get("token") !== rec.accessToken)
        return json(401, { error: "token" });
      const o = this.orders.get(rec.termsHash);
      return json(200, {
        v: 1,
        order_id: rec.orderId,
        quote_id: rec.quote.quote_id,
        status: o
          ? ["awaiting_payment", "rendering", "in_review", "key_published", "refunded", "void", "rejected"][o.status]
          : "awaiting_payment",
        terms: rec.quote.terms,
        terms_hash: rec.termsHash,
        escrow: rec.escrow,
        factory: FACTORY,
        progress: { stage: "rendering", percent: 60, eta_s: 20 },
        spec: rec.quote.spec,
        ...(rec.changes ? { changes: rec.changes } : {}),
      });
    }
    if (p === "/v1/orders" && req.method === "GET") {
      const buyer = url.searchParams.get("buyer")?.toLowerCase();
      const list = [...this.quotes.values()]
        .filter((r) => r.terms.buyer.toLowerCase() === buyer && r.quote.status === "paid")
        .map((r) => ({ order_id: r.orderId, status: "paid" }));
      return json(200, { orders: list });
    }
    if (p === "/v1/auth/siwe/challenge") {
      const issued = new Date();
      const exp = new Date(issued.getTime() + 10 * 60_000);
      let message = [
        `api.kf.test wants you to sign in with your Ethereum account:`,
        getAddress(String(data.address)),
        "",
        "Sign in to Keyframe to list your orders.",
        "",
        `URI: ${HOSTS.api}/v1/auth/siwe/verify`,
        "Version: 1",
        "Chain ID: 8453",
        "Nonce: abcdef0123456789",
        `Issued At: ${issued.toISOString()}`,
        `Expiration Time: ${exp.toISOString()}`,
      ].join("\n");
      if (this.hooks.siwe) message = this.hooks.siwe(message);
      return json(200, { message });
    }
    if (p === "/v1/auth/siwe/verify") {
      const ok = await verifyMessage({
        address: data.address as Address,
        message: String(data.message),
        signature: data.signature as Hex,
      });
      if (!ok) return json(401, { error: "bad_signature" });
      const list = [...this.quotes.values()]
        .filter((r) => r.terms.buyer.toLowerCase() === String(data.address).toLowerCase() && r.quote.status === "paid")
        .map((r) => ({
          order_id: r.orderId,
          quote_id: r.quote.quote_id,
          status: "paid",
          access_token: r.accessToken,
          k_buyer: r.kBuyer === ZERO32 ? null : r.kBuyer,
        }));
      return json(200, { orders: list });
    }
    m = /^\/v1\/reviews\/(o_\w+)\/(challenge|submit)$/.exec(p);
    if (m) {
      const rec = this.byOrder.get(m[1] as string);
      if (!rec || data.access_token !== rec.accessToken) return json(401, { error: "token" });
      if (m[2] === "submit" && data.decision === "changes") {
        // Like the API: off-chain, accept_by = review end + 3 days - 12 min.
        const o = this.orders.get(rec.termsHash);
        const acceptBy = Number(o?.deliveredAt ?? 0n) + rec.terms.reviewWindow + 3 * 86_400 - 720;
        rec.changes = {
          requested_at: now(),
          accept_by: acceptBy,
          revision: null,
          policy: "After a change request Keyframe never releases payment on silence.",
        };
        return json(200, { tx: null, status: "changes_requested", accept_by: acceptBy });
      }
      if (m[2] === "submit")
        return json(200, { tx: keccak256(toHex(`relay:${rec.orderId}:${String(data.decision)}`)), status: "relayed" });
      const deadline = now() + 900;
      let td: Record<string, unknown> =
        data.decision === "changes"
          ? {
              types: {
                ChangeRequest: [
                  { name: "termsHash", type: "bytes32" },
                  { name: "deadline", type: "uint256" },
                ],
              },
              primaryType: "ChangeRequest",
              domain: { name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: FACTORY },
              message: { termsHash: rec.termsHash, deadline: String(deadline) },
            }
          : {
              types: {
                Decision: [
                  { name: "termsHash", type: "bytes32" },
                  { name: "accept", type: "bool" },
                  { name: "deadline", type: "uint256" },
                ],
              },
              primaryType: "Decision",
              domain: { name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: FACTORY },
              message: { termsHash: rec.termsHash, accept: data.decision === "accept", deadline: String(deadline) },
            };
      if (this.hooks.typedData) td = this.hooks.typedData(td, rec);
      return json(200, { typed_data: td });
    }
    return json(404, { error: "no_route" });
  }

  private async rpc(req: Request, host: string): Promise<Response> {
    const calls = JSON.parse(await req.text()) as { id: number; method: string; params: unknown[] }[];
    const out = calls.map((c) => {
      try {
        let result = this.rpcResult(c.method, c.params);
        if (this.hooks.rpc) result = this.hooks.rpc(host, c.method, c.params, result);
        return { jsonrpc: "2.0", id: c.id, result };
      } catch (e) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: (e as Error).message } };
      }
    });
    return json(200, out);
  }

  private rpcResult(method: string, params: unknown[]): unknown {
    const a = String(params[0] ?? "").toLowerCase();
    switch (method) {
      case "eth_chainId":
        return "0x2105";
      case "eth_getCode":
        return this.codes.get(a) ?? "0x";
      case "eth_getBalance":
        return toHex(this.eth.get(a) ?? 0n);
      case "eth_getTransactionReceipt":
        return this.receipts.get(a) ?? null;
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: Hex };
        const call = decodeFunctionData({ abi: [...erc20Abi, ...keyframeFactoryAbi], data });
        if (call.functionName === "balanceOf") {
          const who = String(call.args[0]).toLowerCase();
          if (to.toLowerCase() === USDC.toLowerCase()) {
            return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: this.usdc.get(who) ?? 0n });
          }
          return encodeFunctionResult({
            abi: erc20Abi,
            functionName: "balanceOf",
            result: this.tokens.get(`${to.toLowerCase()}:${who}`) ?? 0n,
          });
        }
        if (call.functionName === "order" && to.toLowerCase() === FACTORY.toLowerCase()) {
          const o = this.orders.get(String(call.args[0]).toLowerCase()) ?? this.emptyOrder();
          return encodeFunctionResult({ abi: keyframeFactoryAbi, functionName: "order", result: o });
        }
        throw new Error("execution reverted");
      }
      default:
        throw new Error(`unsupported ${method}`);
    }
  }
}

/** fetch() backed by a World, honouring AbortSignal and redirect:"error" like Node's fetch. */
export function worldFetch(world: World) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      world.handle(req).then(
        (res) => {
          signal?.removeEventListener("abort", onAbort);
          if (res.status >= 300 && res.status < 400 && init?.redirect === "error") {
            reject(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
          } else resolve(res);
        },
        (e) => reject(e),
      );
    });
  };
}
