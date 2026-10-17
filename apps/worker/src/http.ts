import { type Logger, safeUrl } from "./log.ts";

// HTTP with bounded retries. Retried: network errors, timeouts, 408, 425, 429, 5xx. Never retried: other 4xx
// (the request itself is wrong, or the job was cancelled). At most `attempts` tries (default 3).

export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(status: number | null, message: string, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  log?: Logger;
  what: string;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const attempts = o.attempts ?? 3;
  const base = o.baseDelayMs ?? 500;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      const retryable = e instanceof HttpError ? e.retryable : !(o.signal?.aborted ?? false);
      if (!retryable || i === attempts || o.signal?.aborted) break;
      const delay = base * 2 ** (i - 1) + Math.floor(Math.random() * base);
      o.log?.warn({ what: o.what, attempt: i, delayMs: delay, err: (e as Error).message }, "retrying");
      await sleep(delay, o.signal);
    }
  }
  throw last;
}

function classify(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** fetch with a per-try timeout; maps failures to HttpError. */
export async function request(
  url: string,
  init: Omit<RequestInit, "signal"> & { timeoutMs: number; signal?: AbortSignal; duplex?: "half" },
): Promise<Response> {
  const signals = [AbortSignal.timeout(init.timeoutMs)];
  if (init.signal) signals.push(init.signal);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new HttpError(null, `${init.method ?? "GET"} ${safeUrl(url)}: ${(e as Error).message}`, true);
  }
  return res;
}

export async function expectOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
  throw new HttpError(res.status, `${what}: HTTP ${res.status}${body ? ` ${body}` : ""}`, classify(res.status));
}
