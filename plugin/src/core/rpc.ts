// Minimal JSON-RPC client over KEYFRAME_RPC_URLS. Every read is sent as one batch to each configured RPC in
// parallel (2 by default) and the decoded answers are compared, so a single lying or lagging RPC is visible.
// RPC URLs are never echoed: sources are reported by position only.

import type { Budget } from "./net.js";
import { fetchBounded, NetError, parseJson } from "./net.js";

export type RpcRequest = { method: string; params: unknown[] };

export type Read<T> = { key: string; req: RpcRequest; decode: (result: unknown) => T };

export type ReadValue<T> = {
  /** Decoded value from the first RPC that answered (undefined if none did). */
  value: T | undefined;
  /** Number of RPCs that returned a decodable answer. */
  seen: number;
  /** True when every answering RPC returned the same value. */
  agree: boolean;
  /** Every decodable answer, in RPC order. */
  values: T[];
};

export type CrossRead = {
  configured: number;
  /** RPCs that answered the batch at all. */
  responded: number;
  get<T>(read: Read<T>): ReadValue<T>;
};

const RPC_CAP_MS = 3_500;
const MAX_RPC_BYTES = 512 * 1024;

type Outcome = { ok: true; result: unknown } | { ok: false };

async function batch(url: string, reqs: RpcRequest[], budget: Budget): Promise<Outcome[] | null> {
  const body = JSON.stringify(reqs.map((r, id) => ({ jsonrpc: "2.0", id, method: r.method, params: r.params })));
  let json: unknown;
  try {
    const res = await fetchBounded(
      url,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body },
      budget,
      { capMs: RPC_CAP_MS, maxBytes: MAX_RPC_BYTES },
    );
    if (res.status !== 200) return null;
    json = parseJson(res.bytes);
  } catch (error) {
    if (error instanceof NetError) return null;
    throw error;
  }
  if (!Array.isArray(json)) return null;
  const out: Outcome[] = reqs.map(() => ({ ok: false }));
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const { id, result, error } = item as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= reqs.length) continue;
    if (error === undefined && result !== undefined) out[id] = { ok: true, result };
  }
  return out;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x.toString()}n` : x)) ?? "undefined";

export async function crossRead(
  rpcUrls: readonly string[],
  reads: Read<unknown>[],
  budget: Budget,
): Promise<CrossRead> {
  const reqs = reads.map((r) => r.req);
  const answers = reqs.length === 0 ? [] : await Promise.all(rpcUrls.map((u) => batch(u, reqs, budget)));
  const responded = answers.filter((a) => a !== null).length;
  const table = new Map<string, ReadValue<unknown>>();
  reads.forEach((read, i) => {
    const decoded: unknown[] = [];
    for (const a of answers) {
      const o = a?.[i];
      if (!o?.ok) continue;
      try {
        decoded.push(read.decode(o.result));
      } catch {
        // undecodable answer from this RPC: treated as no answer
      }
    }
    const first = decoded[0];
    table.set(read.key, {
      value: first,
      seen: decoded.length,
      agree: decoded.every((d) => stable(d) === stable(first)),
      values: decoded,
    });
  });
  return {
    configured: rpcUrls.length,
    responded,
    get<T>(read: Read<T>): ReadValue<T> {
      return (
        (table.get(read.key) as ReadValue<T> | undefined) ?? { value: undefined, seen: 0, agree: true, values: [] }
      );
    },
  };
}
