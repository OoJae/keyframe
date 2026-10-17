// The watch page's verification core, shipped verbatim inside the page's inline module (allowed by CSP hash) and
// evaluated as-is by the tests and by scripts/watch-live-check.mjs (`new Function(core + "return {…}")`). Plain
// browser JavaScript, globals only (WebCrypto, fetch, TextEncoder): no imports, no template literals, nothing the
// bundler could rewrite.
//
// It ports packages/protocol/src/kfc1.ts (frozen-interfaces.md §5):
//   K_file = HKDF-SHA256(IKM = K_chain ‖ K_buyer, salt = T.salt, info = "keyframe/kfc1/file", L = 32)
//   chunk i = AES-256-GCM(K_file, nonce = 0^4 ‖ u64be(i), aad = "KFC1" ‖ T.salt ‖ u64be(i) ‖ u64be(n))
// K_buyer is 32 zero bytes for public delivery (§4). K_chain is read from factory.order(termsHash): OrderView is
// all-static (12 words), the key is word 8 and the manifest hash word 9. Every step fails closed: no unauthenticated
// byte is ever returned.

/** Names the core defines (for tests and scripts that evaluate it). */
export const OPEN_CORE_EXPORTS = [
  "OpenError",
  "ORDER_SELECTOR",
  "ZERO32",
  "STATUS_RELEASED",
  "sha256Hex",
  "decodeOrderView",
  "ethCallOrder",
  "readKeyFromBase",
  "deriveFileKey",
  "parseManifest",
  "openKfc1",
  "openFromStorage",
] as const;

// biome-ignore lint/complexity/noUselessStringRaw: keeps any regex escape added later verbatim, as in WATCH_UI_JS
export const OPEN_CORE_JS = String.raw`
const KFC1_CHUNK_PLAINTEXT = 1048560;
const KFC1_TAG_BYTES = 16;
const KFC1_CHUNK_CIPHERTEXT = KFC1_CHUNK_PLAINTEXT + KFC1_TAG_BYTES;
const KFC1_MAX_BYTES = 256 * 1024 * 1024;
const ORDER_SELECTOR = "0xe80160ab"; // order(bytes32)
const ZERO32 = "0x" + "0".repeat(64);
const STATUS_RELEASED = 3;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const UTF8 = new TextEncoder();

class OpenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenError";
    this.code = code;
  }
}

function hexToBytes(hex, what) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) throw new OpenError("bad_input", what + " is not hex");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

function bytes32(hex, what) {
  if (typeof hex !== "string" || !B32_RE.test(hex)) throw new OpenError("bad_input", what + " must be 32-byte hex");
  return hexToBytes(hex, what);
}

function bytesToHex(u) {
  let s = "0x";
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0");
  return s;
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function u64be(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

async function sha256Hex(bytes) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** factory.order(termsHash) return data (12 static words) -> the fields the page uses. */
function decodeOrderView(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{768}$/.test(data)) {
    throw new OpenError("rpc_bad_answer", "unexpected answer to factory.order");
  }
  const word = (i) => data.slice(2 + i * 64, 2 + (i + 1) * 64).toLowerCase();
  const num = (i) => BigInt("0x" + word(i));
  return {
    status: Number(num(0)),
    buyer: "0x" + word(1).slice(24),
    deadline: Number(num(2)),
    openedAt: Number(num(4)),
    deliveredAt: Number(num(5)),
    finalAt: Number(num(6)),
    key: "0x" + word(8),
    manifestHash: "0x" + word(9),
    toSeller: num(10).toString(),
    toBuyer: num(11).toString(),
  };
}

async function ethCallOrder(rpc, factory, termsHash, fetchFn, timeoutMs) {
  bytes32(termsHash, "terms hash");
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: factory, data: ORDER_SELECTOR + termsHash.slice(2).toLowerCase() }, "latest"],
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 8000);
  try {
    const res = await fetchFn(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctl.signal,
      credentials: "omit",
    });
    if (!res.ok) throw new OpenError("rpc_http", "HTTP " + res.status);
    const j = await res.json();
    if (!j || typeof j.result !== "string") {
      const why = j && j.error && j.error.message ? String(j.error.message).slice(0, 120) : "no result";
      throw new OpenError("rpc_error", why);
    }
    return decodeOrderView(j.result);
  } finally {
    clearTimeout(timer);
  }
}

function sameReading(a, b) {
  return a.status === b.status && a.key === b.key && a.manifestHash === b.manifestHash;
}

/**
 * factory.order(termsHash) on every RPC. At least one must answer; any readings that show a published key must
 * agree with each other (a lagging RPC that has not seen the release yet is tolerated, not trusted for the key).
 */
async function readKeyFromBase(rpcs, factory, termsHash, fetchFn, timeoutMs) {
  const f = fetchFn || ((url, init) => fetch(url, init));
  const settled = await Promise.allSettled(rpcs.map((r) => ethCallOrder(r, factory, termsHash, f, timeoutMs)));
  const readings = settled.map((s, i) => ({
    rpc: rpcs[i],
    view: s.status === "fulfilled" ? s.value : null,
    error: s.status === "rejected" ? String((s.reason && s.reason.message) || s.reason) : null,
  }));
  const ok = readings.filter((r) => r.view !== null);
  if (ok.length === 0) throw new OpenError("rpc_unreachable", "no Base RPC answered");
  const released = ok.filter((r) => r.view.status === STATUS_RELEASED && r.view.key !== ZERO32);
  for (const r of released) {
    if (!sameReading(r.view, released[0].view)) {
      throw new OpenError("rpc_disagree", "the Base RPCs disagree about this order's key");
    }
  }
  return {
    view: (released[0] || ok[0]).view,
    answered: ok.length,
    asked: rpcs.length,
    agree: ok.length > 1 && ok.every((r) => sameReading(r.view, ok[0].view)),
    readings,
  };
}

/** K_file as a non-extractable AES-256-GCM key. */
async function deriveFileKey(kChain, kBuyer, salt) {
  const ikm = concatBytes([bytes32(kChain, "K_chain"), bytes32(kBuyer, "K_buyer")]);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes32(salt, "salt"), info: UTF8.encode("keyframe/kfc1/file") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function decryptChunk(key, chunk, i, n, saltBytes) {
  const len = chunk.byteLength;
  const sizeOk = i < n - 1 ? len === KFC1_CHUNK_CIPHERTEXT : len > KFC1_TAG_BYTES && len <= KFC1_CHUNK_CIPHERTEXT;
  if (!sizeOk) throw new OpenError("chunk_length", "piece " + (i + 1) + " of " + n + " has the wrong length");
  const iv = concatBytes([new Uint8Array(4), u64be(i)]);
  const aad = concatBytes([UTF8.encode("KFC1"), saltBytes, u64be(i), u64be(n)]);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, chunk),
    );
  } catch {
    throw new OpenError("chunk_auth", "piece " + (i + 1) + " of " + n + " did not open with this key");
  }
}

/** A KFC1 v1 manifest (shape only; its hash is checked by the caller). */
function parseManifest(bytes) {
  let m;
  try {
    m = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OpenError("manifest_shape", "the manifest is not JSON");
  }
  const b32 = (x) => typeof x === "string" && B32_RE.test(x);
  const pos = (x) => Number.isSafeInteger(x) && x > 0;
  const ok =
    m !== null &&
    typeof m === "object" &&
    m.v === 1 &&
    m.alg === "KFC1" &&
    b32(m.salt) &&
    m.chunkSize === KFC1_CHUNK_PLAINTEXT &&
    pos(m.size) &&
    pos(m.chunks) &&
    m.chunks === Math.ceil(m.size / m.chunkSize) &&
    b32(m.plaintextSha256) &&
    Array.isArray(m.ciphertext) &&
    m.ciphertext.length === m.chunks &&
    m.ciphertext.every(b32) &&
    Array.isArray(m.plaintext) &&
    m.plaintext.length === m.chunks &&
    m.plaintext.every(b32) &&
    m.media !== null &&
    typeof m.media === "object" &&
    typeof m.media.mime === "string";
  if (!ok) throw new OpenError("manifest_shape", "the manifest is not a KFC1 v1 manifest");
  if (m.size > KFC1_MAX_BYTES) throw new OpenError("too_large", "the file is too large to open in a browser");
  return m;
}

/**
 * Opens a KFC1 container. o = { manifestBytes, manifestHash, kChain, kBuyer, salt?, fetchChunk(i), onStep? }.
 * The raw manifest bytes must hash to manifestHash (the API stores the JCS bytes, so no canonicalization here),
 * each chunk must match its ciphertext hash, authenticate under K_file and match its plaintext hash, and the whole
 * file must match plaintextSha256. salt (T.salt), when given, must equal the manifest's.
 */
async function openKfc1(o) {
  const step = o.onStep || (() => {});
  const mh = String(o.manifestHash).toLowerCase();
  if ((await sha256Hex(o.manifestBytes)) !== mh) {
    throw new OpenError("manifest_hash", "the manifest does not match the fingerprint on Base");
  }
  const m = parseManifest(o.manifestBytes);
  if (o.salt && String(o.salt).toLowerCase() !== m.salt.toLowerCase()) {
    throw new OpenError("salt_mismatch", "the manifest belongs to a different deal");
  }
  step("manifest", { manifest: m });
  const key = await deriveFileKey(o.kChain, o.kBuyer, m.salt);
  const saltBytes = bytes32(m.salt, "salt");
  const n = m.chunks;
  const out = new Uint8Array(m.size);
  let off = 0;
  let pending = o.fetchChunk(0);
  for (let i = 0; i < n; i++) {
    const ct = await pending;
    if (i + 1 < n) {
      pending = o.fetchChunk(i + 1);
      pending.catch(() => {}); // awaited next iteration; never an unhandled rejection if this one fails
    }
    if ((await sha256Hex(ct)) !== m.ciphertext[i].toLowerCase()) {
      throw new OpenError("chunk_hash", "encrypted piece " + (i + 1) + " of " + n + " does not match its fingerprint");
    }
    const pt = await decryptChunk(key, ct, i, n, saltBytes);
    if ((await sha256Hex(pt)) !== m.plaintext[i].toLowerCase() || off + pt.byteLength > m.size) {
      throw new OpenError("plaintext_hash", "opened piece " + (i + 1) + " of " + n + " does not match its fingerprint");
    }
    out.set(pt, off);
    off += pt.byteLength;
    step("chunk", { done: i + 1, total: n });
  }
  const sha256 = await sha256Hex(out);
  if (off !== m.size || sha256 !== m.plaintextSha256.toLowerCase()) {
    throw new OpenError("plaintext_hash", "the opened file does not match its fingerprint");
  }
  step("file", { sha256 });
  return { manifest: m, plaintext: out, sha256 };
}

async function fetchBytes(url, accept, fetchFn, maxBytes) {
  let res;
  try {
    res = await fetchFn(url, { headers: { accept }, credentials: "omit" });
  } catch {
    throw new OpenError("fetch", "could not download " + url);
  }
  if (res.status !== 200) throw new OpenError("fetch", "HTTP " + res.status + " for " + url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new OpenError("fetch", "unexpectedly large download: " + url);
  return bytes;
}

/** Downloads {filesBase}/c/{manifestHash}/manifest.json and its {i}.bin chunks, then opens them (openKfc1). */
async function openFromStorage(o) {
  const f = o.fetchFn || ((url, init) => fetch(url, init));
  const mh = String(o.manifestHash).toLowerCase();
  bytes32(mh, "manifest hash");
  const base = o.filesBase + "/c/" + mh;
  const manifestBytes = await fetchBytes(base + "/manifest.json", "application/json", f, 256 * 1024);
  return openKfc1({
    manifestBytes,
    manifestHash: mh,
    kChain: o.kChain,
    kBuyer: o.kBuyer,
    salt: o.salt,
    onStep: o.onStep,
    fetchChunk: (i) => fetchBytes(base + "/" + i + ".bin", "application/octet-stream", f, KFC1_CHUNK_CIPHERTEXT),
  });
}
`;
