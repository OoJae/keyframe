// KV layout for the spike (one namespace, binding SPIKE_KV):
//   ctr:payto                    next HD address index (monotonic counter)
//   idx:<n>                      quote id that claimed HD index n (collision guard)
//   quote:<qid>                  immutable quote JSON
//   paid:<qid>                   {order_id, from, nonce, settlement_tx|null, wire, paid_at}
//   settled:<qid>                deferred-settle outcome (SETTLE_MODE=broadcast only)
//   settle:<from>:<nonce>        stored 200 response for idempotent replay
//   settling:<qid>               short-lived in-flight marker (best effort; KV has no CAS)
//   log:<qid|_other>:<ts>:<rnd>:<a|b>   request log entry (value "", entry in metadata)
//
// KV is eventually consistent and allows ~1 write/s per key; acceptable for a single-operator spike.

import type { StoredQuote } from "./x402.js";

export interface PaidRecord {
  order_id: string;
  from: string | null;
  nonce: string | null;
  settlement_tx: string | null;
  wire: "v1" | "v2";
  paid_at: string;
}

export interface StoredResponse {
  quote_id: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface LogEntry {
  ts: string;
  method: string;
  path: string;
  ua: string | null;
  accept: string | null;
  content_length: string | null;
  body_bytes: number | null;
  payment_header_name: string | null;
  x402_version_of_payload: number | null;
  payment_required_sha256: string | null;
  payment_required_source: "header" | "body" | null;
  status: number;
  ms: number;
  wire: "v1" | "v2";
  note: string | null;
}

const LOG_FIELD_MAX = 160;
export const clip = (v: string | null | undefined, n = LOG_FIELD_MAX): string | null =>
  v == null ? null : v.length > n ? `${v.slice(0, n)}…` : v;

export async function getQuote(kv: KVNamespace, qid: string): Promise<StoredQuote | null> {
  return kv.get<StoredQuote>(`quote:${qid}`, "json");
}

export async function putQuote(kv: KVNamespace, quote: StoredQuote): Promise<void> {
  await kv.put(`quote:${quote.quote_id}`, JSON.stringify(quote));
}

export async function getPaid(kv: KVNamespace, qid: string): Promise<PaidRecord | null> {
  return kv.get<PaidRecord>(`paid:${qid}`, "json");
}

export async function putPaid(kv: KVNamespace, qid: string, rec: PaidRecord): Promise<void> {
  await kv.put(`paid:${qid}`, JSON.stringify(rec));
}

export async function getSettled(kv: KVNamespace, qid: string): Promise<Record<string, unknown> | null> {
  return kv.get<Record<string, unknown>>(`settled:${qid}`, "json");
}

export async function putSettled(kv: KVNamespace, qid: string, rec: Record<string, unknown>): Promise<void> {
  await kv.put(`settled:${qid}`, JSON.stringify(rec));
}

export async function getStoredResponse(kv: KVNamespace, from: string, nonce: string): Promise<StoredResponse | null> {
  return kv.get<StoredResponse>(`settle:${from}:${nonce}`, "json");
}

export async function putStoredResponse(kv: KVNamespace, from: string, nonce: string, rec: StoredResponse): Promise<void> {
  await kv.put(`settle:${from}:${nonce}`, JSON.stringify(rec));
}

export async function getSettling(kv: KVNamespace, qid: string): Promise<{ from: string | null; nonce: string | null } | null> {
  return kv.get(`settling:${qid}`, "json");
}

export async function putSettling(kv: KVNamespace, qid: string, rec: { from: string | null; nonce: string | null }): Promise<void> {
  await kv.put(`settling:${qid}`, JSON.stringify(rec), { expirationTtl: 120 });
}

export async function clearSettling(kv: KVNamespace, qid: string): Promise<void> {
  await kv.delete(`settling:${qid}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Claims the next HD index. Retries around KV's 1 write/s/key limit and checks the idx:<n> claim. */
export async function allocatePayeeIndex(kv: KVNamespace, qid: string): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const raw = await kv.get("ctr:payto");
    let n = raw && /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
    while (await kv.get(`idx:${n}`)) n += 1; // skip indexes already claimed (stale counter read)
    if (n >= 0x7fffffff) throw new Error("payee index space exhausted");
    try {
      await kv.put(`idx:${n}`, qid);
      await kv.put("ctr:payto", String(n + 1));
      return n;
    } catch {
      await sleep(1100);
    }
  }
  throw new Error("could not allocate payee index");
}

export function logKeyBase(qid: string | null): string {
  const bucket = qid ?? "_other";
  const ts = String(Date.now()).padStart(13, "0");
  const rnd = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `log:${bucket}:${ts}:${rnd}`;
}

export async function writeLog(kv: KVNamespace, keyBase: string, suffix: "a" | "b", entry: LogEntry): Promise<void> {
  // The entry lives in metadata (<= 1024 bytes) so one list() call returns the whole log; 30-day TTL.
  await kv.put(`${keyBase}:${suffix}`, "", { metadata: entry, expirationTtl: 60 * 60 * 24 * 30 });
}

export async function readLog(kv: KVNamespace, qid: string): Promise<LogEntry[]> {
  const out = new Map<string, { suffix: string; entry: LogEntry }>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await kv.list<LogEntry>({ prefix: `log:${qid}:`, cursor, limit: 1000 });
    for (const k of res.keys) {
      if (!k.metadata) continue;
      const base = k.name.slice(0, -2);
      const suffix = k.name.slice(-1);
      const prev = out.get(base);
      if (!prev || suffix > prev.suffix) out.set(base, { suffix, entry: k.metadata });
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v.entry);
}
