// Bounded networking. The PayBox sandbox gives each operation 10 s; every tool runs inside one Budget (8.5 s) and
// every request gets AbortSignal.timeout(min(cap <= 4 s, remaining - margin)). Redirects are errors (exact hosts
// only), bodies are read under a byte cap, and failures are classified without echoing URLs.

export const TOOL_BUDGET_MS = 8_500;
export const PER_CALL_MAX_MS = 4_000;
const MARGIN_MS = 300;
const MIN_USEFUL_MS = 250;

export class Budget {
  private readonly deadline: number;
  constructor(
    totalMs: number = TOOL_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + totalMs;
  }
  remaining(): number {
    return Math.max(0, this.deadline - this.now());
  }
  /** Timeout for the next request: min(cap, remaining - margin), or 0 when no useful attempt fits. */
  slot(capMs: number = PER_CALL_MAX_MS): number {
    const left = this.remaining() - MARGIN_MS;
    if (left < MIN_USEFUL_MS) return 0;
    return Math.min(capMs, PER_CALL_MAX_MS, left);
  }
}

export type NetFailure = "timeout" | "network" | "redirect" | "budget" | "too_large";

export class NetError extends Error {
  override name = "NetError";
  constructor(
    readonly kind: NetFailure,
    message: string,
  ) {
    super(message);
  }
}

const DESCRIBE: Record<NetFailure, string> = {
  timeout: "timed out",
  network: "could not connect",
  redirect: "answered with a redirect (not followed)",
  budget: "was skipped because this call's time budget ran out",
  too_large: "returned more data than allowed",
};

export const describeNetError = (e: NetError): string => DESCRIBE[e.kind];

function classify(error: unknown): NetError {
  if (error instanceof NetError) return error;
  const e = error as { name?: string; message?: string; cause?: { message?: string } } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return new NetError("timeout", "timeout");
  const text = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  if (/redirect/i.test(text)) return new NetError("redirect", "redirect");
  return new NetError("network", "network");
}

export type Fetched = { status: number; headers: Headers; bytes: Uint8Array };

/** One bounded HTTP request; the timeout covers headers and body. Throws NetError only. */
export async function fetchBounded(
  url: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
  budget: Budget,
  opts: { capMs?: number; maxBytes: number },
): Promise<Fetched> {
  const timeout = budget.slot(opts.capMs);
  if (timeout === 0) throw new NetError("budget", "budget");
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new NetError("redirect", "redirect");
    }
    return { status: res.status, headers: res.headers, bytes: await readCapped(res, opts.maxBytes) };
  } catch (error) {
    throw classify(error);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new NetError("too_large", "too_large");
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NetError("too_large", "too_large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export const utf8Text = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** JSON.parse that returns undefined instead of throwing. */
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Text(bytes));
  } catch {
    return undefined;
  }
}
