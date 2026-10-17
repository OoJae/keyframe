import { createHash } from "node:crypto";
import { encryptKfc1, jcs, keyframeFactoryAbi, PaidResponseSchema, Status, sha256Hex } from "@keyframe/protocol";
import { bytesToHex, encodeFunctionResult, type Hex, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import type { OrderView } from "../src/chain.js";
import type { R2Like } from "../src/platform.js";
import { parseRange, R2Storage, resolveRange } from "../src/storage.js";
import { BASE_RPCS } from "../src/web/html.js";
import { OPEN_CORE_EXPORTS, OPEN_CORE_JS } from "../src/web/open-core.js";
import { WATCH_SCRIPT } from "../src/web/watch.js";
import { fixture, Harness, type Json, PUBLIC_BASE, padMp4 } from "./support/harness.js";

// The watch & download page (/w/{order_id}), its in-browser verification core, the /files Range and manifest-URL
// behaviour, the additive watch/preview links, and the /q and / pages.

type Core = {
  // biome-ignore lint/suspicious/noExplicitAny: the core is untyped browser JavaScript
  [K in (typeof OPEN_CORE_EXPORTS)[number]]: any;
};
/** The core exactly as the page ships it (a static string), evaluated the way scripts/watch-live-check.mjs does. */
const core: Core = new Function(`"use strict";\n${OPEN_CORE_JS}\nreturn { ${OPEN_CORE_EXPORTS.join(", ")} };`)();

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const rand32 = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const MEDIA = { mime: "video/mp4", width: 1080, height: 1920, durationMs: 8000, fps: 30 };

async function sealed(plaintext: Uint8Array, kBuyer: Hex = ZERO32) {
  const kChain = rand32();
  const salt = rand32();
  const enc = await encryptKfc1(plaintext, { kChain, kBuyer, salt, media: MEDIA });
  const manifestBytes = new TextEncoder().encode(jcs(enc.manifest)); // what the API stores (JCS bytes)
  return { kChain, kBuyer, salt, enc, manifestBytes };
}

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "opened";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

/** Answers eth_call factory.order(termsHash) from `views` (per RPC URL), like a public Base RPC. */
function fakeRpcs(views: Record<string, (() => OrderView) | "down">) {
  return async (url: string, init: RequestInit) => {
    const v = views[url];
    if (!v || v === "down") return new Response("unavailable", { status: 503 });
    const req = JSON.parse(String(init.body));
    expect(req.method).toBe("eth_call");
    expect(req.params[0].data.slice(0, 10)).toBe(toFunctionSelector("order(bytes32)"));
    const result = encodeFunctionResult({ abi: keyframeFactoryAbi, functionName: "order", result: v() });
    return Response.json({ jsonrpc: "2.0", id: req.id, result });
  };
}

function releasedView(key: Hex, manifestHash: Hex): OrderView {
  return {
    status: Status.Released,
    buyer: "0x1941B737fD7AF37344Ea86448EE9Ff66715F7995",
    deadline: 1_792_236_670n,
    reviewWindow: 0,
    openedAt: 1_792_234_321n,
    deliveredAt: 0n,
    finalAt: 1_792_234_367n,
    accepted: false,
    key,
    manifestHash,
    toSeller: 1_000_000n,
    toBuyer: 0n,
  };
}

/** Routes the core's downloads into the app (the page fetches /files on its own origin). */
const viaApp = (h: Harness) => (url: string, init?: RequestInit) => h.request(url.slice(PUBLIC_BASE.length), init);

async function paid(h: Harness, over: Record<string, unknown> = {}) {
  const q = await h.finalQuote(over);
  const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { q, text, body: JSON.parse(text) as Json };
}

describe("watch page core (in-browser KFC1 open)", () => {
  it("opens a real multi-chunk KFC1 container and checks every hash", async () => {
    const mp4 = padMp4(fixture("countdown-8s-9x16.m4v"), 2_500_000); // 3 chunks
    const s = await sealed(mp4);
    const steps: string[] = [];
    const out = await core.openKfc1({
      manifestBytes: s.manifestBytes,
      manifestHash: s.enc.manifestHash,
      kChain: s.kChain,
      kBuyer: s.kBuyer,
      salt: s.salt,
      fetchChunk: async (i: number) => s.enc.chunks[i],
      onStep: (name: string) => steps.push(name),
    });
    expect(out.manifest.chunks).toBe(3);
    expect(Buffer.from(out.plaintext).equals(Buffer.from(mp4))).toBe(true);
    expect(out.sha256).toBe(await sha256Hex(mp4));
    expect(steps).toEqual(["manifest", "chunk", "chunk", "chunk", "file"]);
  });

  it("fails closed: tampered chunk, forged chunk hash, wrong key, wrong K_buyer, wrong manifest, wrong salt", async () => {
    const mp4 = padMp4(fixture("countdown-8s-9x16.m4v"), 1_200_000); // 2 chunks
    const kb = rand32();
    const s = await sealed(mp4, kb);
    const base = {
      manifestBytes: s.manifestBytes,
      manifestHash: s.enc.manifestHash,
      kChain: s.kChain,
      kBuyer: kb,
      salt: s.salt,
      fetchChunk: async (i: number) => s.enc.chunks[i],
    };
    expect(await errorCode(core.openKfc1(base))).toBe("opened");

    const tampered = s.enc.chunks.map((c, i) => {
      const t = new Uint8Array(c);
      if (i === 1) t.set([(t[5] ?? 0) ^ 0x01], 5);
      return t;
    });
    expect(await errorCode(core.openKfc1({ ...base, fetchChunk: async (i: number) => tampered[i] }))).toBe(
      "chunk_hash",
    );

    // a manifest that commits to the tampered ciphertext (so its hash checks pass) still cannot authenticate it
    const forged = { ...s.enc.manifest, ciphertext: await Promise.all(tampered.map((c) => sha256Hex(c))) };
    const forgedBytes = new TextEncoder().encode(jcs(forged));
    expect(
      await errorCode(
        core.openKfc1({
          ...base,
          manifestBytes: forgedBytes,
          manifestHash: await sha256Hex(forgedBytes),
          fetchChunk: async (i: number) => tampered[i],
        }),
      ),
    ).toBe("chunk_auth");

    expect(await errorCode(core.openKfc1({ ...base, kChain: rand32() }))).toBe("chunk_auth");
    expect(await errorCode(core.openKfc1({ ...base, kBuyer: ZERO32 }))).toBe("chunk_auth"); // private needs k_buyer
    expect(await errorCode(core.openKfc1({ ...base, manifestHash: rand32() }))).toBe("manifest_hash");
    const other = await sealed(mp4, kb);
    expect(await errorCode(core.openKfc1({ ...base, manifestBytes: other.manifestBytes }))).toBe("manifest_hash");
    expect(await errorCode(core.openKfc1({ ...base, salt: rand32() }))).toBe("salt_mismatch");
    // swapped chunk order: hash check catches it before decryption
    expect(await errorCode(core.openKfc1({ ...base, fetchChunk: async (i: number) => s.enc.chunks[1 - i] }))).toBe(
      "chunk_hash",
    );
    // a manifest lying about the whole-file hash (consistent per-chunk hashes)
    const lying = { ...s.enc.manifest, plaintextSha256: rand32() };
    const lyingBytes = new TextEncoder().encode(jcs(lying));
    expect(
      await errorCode(core.openKfc1({ ...base, manifestBytes: lyingBytes, manifestHash: await sha256Hex(lyingBytes) })),
    ).toBe("plaintext_hash");
  });

  it("decodes factory.order exactly as the ABI encodes it (key = word 8, manifestHash = word 9)", async () => {
    expect(core.ORDER_SELECTOR).toBe(toFunctionSelector("order(bytes32)"));
    const key = rand32();
    const mh = rand32();
    const data = encodeFunctionResult({
      abi: keyframeFactoryAbi,
      functionName: "order",
      result: releasedView(key, mh),
    });
    expect(core.decodeOrderView(data)).toEqual({
      status: Status.Released,
      buyer: "0x1941b737fd7af37344ea86448ee9ff66715f7995",
      deadline: 1_792_236_670,
      openedAt: 1_792_234_321,
      deliveredAt: 0,
      finalAt: 1_792_234_367,
      key,
      manifestHash: mh,
      toSeller: "1000000",
      toBuyer: "0",
    });
    expect(() => core.decodeOrderView("0x1234")).toThrow(/unexpected answer/);
  });

  it("reads the key on two RPCs: agreement, one down, one lagging, disagreement, none", async () => {
    const [a, b] = BASE_RPCS;
    const key = rand32();
    const mh = rand32();
    const rel = () => releasedView(key, mh);
    const read = (views: Parameters<typeof fakeRpcs>[0]) =>
      core.readKeyFromBase([a, b], "0x00000000000000000000000000000000000f4c70", rand32(), fakeRpcs(views));

    const both = await read({ [a]: rel, [b]: rel });
    expect(both).toMatchObject({ answered: 2, asked: 2, agree: true, view: { key, manifestHash: mh } });

    const one = await read({ [a]: "down", [b]: rel });
    expect(one).toMatchObject({ answered: 1, agree: false, view: { key } });
    expect(one.readings[0].error).toMatch(/503/);

    const lagging = await read({
      [a]: () => ({ ...rel(), status: Status.Open, key: ZERO32, manifestHash: ZERO32 }),
      [b]: rel,
    });
    expect(lagging).toMatchObject({ answered: 2, agree: false, view: { status: Status.Released, key } });

    const notYet = await read({ [a]: () => ({ ...rel(), status: Status.Open, key: ZERO32 }), [b]: "down" });
    expect(notYet.view.key).toBe(ZERO32);

    expect(await errorCode(read({ [a]: rel, [b]: () => releasedView(rand32(), mh) }))).toBe("rpc_disagree");
    expect(await errorCode(read({ [a]: "down", [b]: "down" }))).toBe("rpc_unreachable");
  });

  it("the page's inline module parses as one script (core + UI share a scope without clashes)", () => {
    expect(() => new Function(WATCH_SCRIPT)).not.toThrow();
    expect(WATCH_SCRIPT.startsWith(OPEN_CORE_JS)).toBe(true);
  });
});

describe("GET /w/{order_id}", () => {
  it("serves the page with a strict CSP, and its core opens the delivered file from /files with the key from Base", async () => {
    const h = new Harness();
    const { body } = await paid(h);
    await h.drain(); // release: the key is now in the factory's OrderView
    const res = await h.request(`/w/${body.order_id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self' https://mainnet.base.org https://base-rpc.publicnode.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    // the inline module is exactly WATCH_SCRIPT and its sha256 is the one CSP allows
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBe(WATCH_SCRIPT);
    const hash = createHash("sha256")
      .update(script ?? "")
      .digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(csp).toContain(`style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`);
    expect(html).not.toMatch(/ style="/); // inline style attributes would need 'unsafe-inline'
    // no secrets: neither the access token nor anything derived from KMASTER
    expect(html).not.toContain(body.access_token);
    expect(html).not.toContain(h.kmasterHex.slice(2, 18));
    const data = JSON.parse(/<script type="application\/json" id="kf-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "");
    expect(data).toMatchObject({ order_id: body.order_id, api: `/v1/orders/${body.order_id}`, rpcs: BASE_RPCS });
    expect(html).toContain("KEY PUBLISHED");

    // what the script does, step by step: order view → key from Base → manifest + chunks → open
    const view = (await (await h.request(data.api)).json()) as Json;
    const factoryView = () => h.factory.view(view.terms_hash);
    const chain = await core.readKeyFromBase(
      data.rpcs,
      view.factory,
      view.terms_hash,
      fakeRpcs({ [BASE_RPCS[0]]: factoryView, [BASE_RPCS[1]]: factoryView }),
    );
    expect(chain).toMatchObject({ agree: true, view: { status: Status.Released, manifestHash: view.manifest_hash } });
    const out = await core.openFromStorage({
      filesBase: data.files_base,
      manifestHash: chain.view.manifestHash,
      kChain: chain.view.key,
      kBuyer: ZERO32,
      salt: view.terms.salt,
      fetchFn: viaApp(h),
    });
    expect(Buffer.from(out.plaintext).equals(Buffer.from(fixture("countdown-8s-9x16.m4v")))).toBe(true);
    expect(view.terms.contentHash).toBe(chain.view.manifestHash); // Instant: the file committed before payment
  });

  it("private orders open only with k_buyer (the owner view or #kb=)", async () => {
    const h = new Harness();
    const { body } = await paid(h, { delivery: "private" });
    await h.drain();
    expect(body.k_buyer).toMatch(/^0x[0-9a-f]{64}$/);
    const html = await (await h.request(`/w/${body.order_id}`)).text();
    expect(html).not.toContain(body.k_buyer);
    const pub = (await (await h.request(`/v1/orders/${body.order_id}`)).json()) as Json;
    expect(pub.k_buyer).toBeUndefined();
    const owner = (await (
      await h.request(`/v1/orders/${body.order_id}`, { headers: { authorization: `Bearer ${body.access_token}` } })
    ).json()) as Json;
    expect(owner.k_buyer).toBe(body.k_buyer);
    const v = h.factory.view(pub.terms_hash);
    const open = (kBuyer: Hex) =>
      core.openFromStorage({
        filesBase: `${PUBLIC_BASE}/files`,
        manifestHash: v.manifestHash,
        kChain: v.key,
        kBuyer,
        fetchFn: viaApp(h),
      });
    expect(await errorCode(open(ZERO32))).toBe("chunk_auth");
    expect(await errorCode(open(body.k_buyer))).toBe("opened");
  });

  it("unknown or malformed ids are 404 HTML pages", async () => {
    const h = new Harness();
    const unknown = await h.request("/w/o_1111111111111111111111");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("text/html");
    expect(await unknown.text()).toContain("Order not found");
    expect((await h.request("/w/nope")).status).toBe(404);
    expect((await h.request("/q/q_1111111111111111111111")).status).toBe(404);
    expect((await h.request("/q/nope")).status).toBe(404);
  });
});

describe("additive links", () => {
  it("paid 200 body: watch_url appended after next, field order fixed, replay byte-identical", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const headers = await h.paymentHeaders(q.quote_id);
    const first = await (await h.pay(q.quote_id, headers)).text();
    const body = PaidResponseSchema.parse(JSON.parse(first)) as Json;
    expect(Object.keys(JSON.parse(first))).toEqual([
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
      "watch_url",
    ]);
    expect(body.watch_url).toBe(`${PUBLIC_BASE}/w/${body.order_id}`);
    expect(await (await h.pay(q.quote_id, headers, "GET")).text()).toBe(first);
  });

  it("order view, list and SIWE bundle carry watch_url + links only once the key is published", async () => {
    const h = new Harness();
    const { body } = await paid(h);
    // before the background release the order is sealed: no watch link yet
    const sealedView = (await (await h.request(`/v1/orders/${body.order_id}`)).json()) as Json;
    expect(sealedView.status).toBe("sealed");
    expect(sealedView.watch_url).toBeUndefined();
    expect(sealedView.links).toBeUndefined();
    await h.drain();
    const watch = `${PUBLIC_BASE}/w/${body.order_id}`;
    const v = (await (await h.request(`/v1/orders/${body.order_id}`)).json()) as Json;
    expect(v).toMatchObject({ status: "key_published", watch_url: watch, links: [{ kind: "watch", url: watch }] });
    const owner = (await (
      await h.request(`/v1/orders/${body.order_id}`, { headers: { authorization: `Bearer ${body.access_token}` } })
    ).json()) as Json;
    expect(owner.watch_url).toBe(watch);
    expect(owner.watch_url).not.toContain(body.access_token);

    const ch = await (await h.postJson("/v1/auth/siwe/challenge", { address: h.buyer.address })).json();
    const signature = await h.buyer.signMessage({ message: ch.message });
    const bundle = await (
      await h.postJson("/v1/auth/siwe/verify", { address: h.buyer.address, message: ch.message, signature })
    ).json();
    expect(bundle.orders[0]).toMatchObject({ order_id: body.order_id, watch_url: watch, links: [{ kind: "watch" }] });
  });

  it("quote view links to the preview page once final (not while draft)", async () => {
    const h = new Harness();
    const draft = await h.createQuote();
    expect(draft.status).toBe("draft");
    expect(draft.links).toBeUndefined();
    await h.render();
    const q = (await (await h.request(`/v1/quotes/${draft.quote_id}`)).json()) as Json;
    expect(q.status).toBe("final");
    expect(q.links).toEqual([{ kind: "preview", url: `${PUBLIC_BASE}/q/${q.quote_id}` }]);
  });
});

describe("/files", () => {
  const KEY = "p/q_11111111111111111111gh-0123abcd-1.mp4";
  const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);

  it("Range → 206 with Content-Range; no Range → the unchanged 200; unsatisfiable → 416", async () => {
    const h = new Harness();
    await h.storage.put(KEY, bytes, "video/mp4");
    const full = await h.request(`/files/${KEY}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(full.headers.get("content-length")).toBe("5000");
    expect(full.headers.get("access-control-allow-origin")).toBe("*");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await full.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);

    const part = async (range: string) => {
      const r = await h.request(`/files/${KEY}`, { headers: { range } });
      return { r, body: new Uint8Array(await r.arrayBuffer()) };
    };
    const first = await part("bytes=0-1023");
    expect(first.r.status).toBe(206);
    expect(first.r.headers.get("content-range")).toBe("bytes 0-1023/5000");
    expect(first.r.headers.get("content-length")).toBe("1024");
    expect(first.r.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(first.body).equals(Buffer.from(bytes.slice(0, 1024)))).toBe(true);
    const probe = await part("bytes=0-1"); // Safari's first media request
    expect(probe.r.headers.get("content-range")).toBe("bytes 0-1/5000");
    expect(probe.body).toEqual(bytes.slice(0, 2));
    const open = await part("bytes=4000-");
    expect(open.r.headers.get("content-range")).toBe("bytes 4000-4999/5000");
    expect(open.body.byteLength).toBe(1000);
    const suffix = await part("bytes=-100");
    expect(suffix.r.headers.get("content-range")).toBe("bytes 4900-4999/5000");
    expect(suffix.body).toEqual(bytes.slice(4900));
    const past = await part("bytes=4990-9999");
    expect(past.r.headers.get("content-range")).toBe("bytes 4990-4999/5000");
    const bad = await part("bytes=5000-");
    expect(bad.r.status).toBe(416);
    expect(bad.r.headers.get("content-range")).toBe("bytes */5000");
    for (const ignored of ["bytes=0-1,4-5", "bytes=9-3", "items=0-1", "bytes=x"]) {
      const r = await part(ignored);
      expect(r.r.status, ignored).toBe(200);
      expect(r.body.byteLength).toBe(5000);
    }
    expect(
      (await h.request("/files/p/q_11111111111111111111gh-0123abcd-2.mp4", { headers: { range: "bytes=0-1" } })).status,
    ).toBe(404);
  });

  it("parseRange / resolveRange and the R2 adapter's native range read", async () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange("bytes=0-")).toEqual({ first: 0, last: null });
    expect(parseRange("bytes=-5")).toEqual({ suffix: 5 });
    expect(parseRange("bytes=-")).toBeNull();
    expect(resolveRange({ suffix: 0 }, 10)).toBeNull();
    expect(resolveRange({ suffix: 50 }, 10)).toEqual({ offset: 0, length: 10 });
    expect(resolveRange({ first: 3, last: 3 }, 10)).toEqual({ offset: 3, length: 1 });

    const gets: unknown[] = [];
    const bucket: R2Like = {
      put: async () => undefined,
      head: async (key) =>
        key === KEY ? { size: bytes.byteLength, httpMetadata: { contentType: "video/mp4" } } : null,
      get: async (key, options) => {
        gets.push(options);
        if (key !== KEY) return null;
        const r = options?.range;
        const slice = r ? bytes.slice(r.offset, r.offset + r.length) : bytes;
        return { size: bytes.byteLength, arrayBuffer: async () => slice.buffer };
      },
    };
    const r2 = new R2Storage(bucket);
    const got = await r2.getRange(KEY, { first: 10, last: 19 });
    expect(got).toMatchObject({ contentType: "video/mp4", size: 5000, range: { offset: 10, length: 10 } });
    expect(got?.bytes).toEqual(bytes.slice(10, 20));
    expect(gets).toEqual([{ range: { offset: 10, length: 10 } }]); // only the range is read
    expect((await r2.getRange(KEY, { first: 6000, last: null }))?.range).toBeNull();
    expect(await r2.getRange("missing", { suffix: 1 })).toBeNull();
  });

  it("manifest URL: JSON clients get the exact stored bytes; a browser navigation is sent to the human page", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const key = `c/${q.content.manifest_hash}/manifest.json`;
    const stored = (await h.storage.get(key))?.bytes;
    expect(stored).toBeDefined();
    const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

    const asJson = async (accept: string | null) => {
      const r = await h.request(`/files/${key}`, accept === null ? {} : { headers: { accept } });
      expect(r.status, String(accept)).toBe(200);
      expect(r.headers.get("vary")).toBe("Accept");
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(stored as Uint8Array))).toBe(true);
    };
    for (const accept of ["application/json", "*/*", null, "text/html, application/json"]) await asJson(accept);
    expect(await sha256Hex(stored as Uint8Array)).toBe(q.content.manifest_hash);

    // before payment: the committing quote's preview page
    const pre = await h.request(`/files/${key}`, { headers: { accept: BROWSER } });
    expect(pre.status).toBe(302);
    expect(pre.headers.get("location")).toBe(`${PUBLIC_BASE}/q/${q.quote_id}`);
    expect(pre.headers.get("vary")).toBe("Accept");
    expect(pre.headers.get("cache-control")).toBe("no-store");

    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    const body = (await res.json()) as Json;
    const post = await h.request(`/files/${key}`, { headers: { accept: BROWSER } });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe(`${PUBLIC_BASE}/w/${body.order_id}`);
    await asJson("application/json");

    // chunks and unknown manifests are never redirected
    const chunk = await h.request(`/files/c/${q.content.manifest_hash}/0.bin`, { headers: { accept: BROWSER } });
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("vary")).toBeNull();
    expect((await h.request(`/files/c/${rand32()}/manifest.json`, { headers: { accept: BROWSER } })).status).toBe(404);
  });

  it("Studio: the delivered manifest redirects to the order's watch page", async () => {
    const h = new Harness();
    const brief = "A confident ten second sting for a parachute-themed DeFi safety brand, calm and precise.";
    const q = await h.createQuote({ format: "studio", params: { deliverable: "studio_sting", brief } });
    const body = (await (await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id))).json()) as Json;
    await h.drain();
    const done = await h.deliverStudio(body.order_id);
    const r = await h.request(`/files/c/${done.manifest_hash}/manifest.json`, { headers: { accept: "text/html" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${PUBLIC_BASE}/w/${body.order_id}`);
    const v = (await (await h.request(`/v1/orders/${body.order_id}`)).json()) as Json;
    expect(v.status).toBe("delivered");
    expect(v.watch_url).toBeUndefined();
    const page = await h.request(`/w/${body.order_id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("IN REVIEW");
  });
});

describe("/q/{quote_id} and /", () => {
  it("preview page: watermarked loop, price, deadline, escrow, how to buy, OG tags, no secrets", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const res = await h.request(`/q/${q.quote_id}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    const html = await res.text();
    expect(html).toContain(`<video src="${q.preview.video_url}"`);
    expect(html).toMatch(/autoplay muted loop playsinline/);
    expect(html).toContain(`<meta property="og:video" content="${q.preview.video_url}">`);
    expect(html).toContain(`<meta property="og:image" content="${q.preview.still_url}">`);
    expect(html).toContain("1.00 USDC");
    expect(html).toContain(q.order_url);
    expect(html).toContain(`https://basescan.org/address/${q.escrow}`);
    expect(html).toContain("READY TO BUY");
    expect(html).not.toContain(h.kmasterHex.slice(2, 18));

    const draft = await h.createQuote();
    const d = await h.request(`/q/${draft.quote_id}`);
    expect(d.status).toBe(200);
    const dh = await d.text();
    expect(dh).toContain('<meta http-equiv="refresh" content="5">');
    expect(dh).not.toContain("How to buy");

    await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    const after = await (await h.request(`/q/${q.quote_id}`)).text();
    expect(after).toContain("PAID");
    expect(after).not.toContain("How to buy");
    expect(after).toMatch(/href="https:\/\/api\.keyframe\.test\/w\/o_/);
  });

  it("front door: one-line pitch, protection steps, live counters, what is orderable, honest disclosures", async () => {
    const h = new Harness();
    const { body } = await paid(h);
    await h.drain();
    const res = await h.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await res.text();
    expect(html).toContain("Pay only on delivery.");
    expect(html).toMatch(/<b>1<\/b><span>orders<\/span>/);
    expect(html).toMatch(/<b>1<\/b><span>keys published<\/span>/);
    expect(html).toMatch(/<b>1\.00<\/b><span>USDC paid on delivery<\/span>/);
    expect(html).toContain("<b>Countdown</b>");
    expect(html).toMatch(/Coming soon:[^<]*Chart Moment/);
    expect(html).toContain("unaudited");
    expect(html).toContain("50.00 USDC");
    for (const href of ["/llms.txt", "/openapi.json", "/health"]) expect(html).toContain(`href="${href}"`);
    // the worked example is linked only where that order exists (production)
    expect(html).not.toContain("first mainnet order");
    expect(html).not.toContain(body.order_id);
  });
});
