// Bounded networking: every request gets AbortSignal.timeout(min(4 s, remaining budget)), redirects are errors,
// and the whole tool call stays inside one budget (< 9 s) so the sandbox's 10 s limit is never hit.

export const PER_CALL_TIMEOUT_MS = 4_000;
const SAFETY_MS = 250;

export class Budget {
  private readonly deadline: number;
  constructor(totalMs: number, private readonly started = Date.now()) {
    this.deadline = started + totalMs;
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }
  elapsed(): number {
    return Date.now() - this.started;
  }
  /** Timeout for the next request, or 0 if there is no time left for a meaningful attempt. */
  slot(cap = PER_CALL_TIMEOUT_MS, minUseful = 300): number {
    const left = this.remaining() - SAFETY_MS;
    return left < minUseful ? 0 : Math.min(cap, left);
  }
}

export type FetchFailure = "timeout" | "aborted" | "redirect" | "network" | "budget_exhausted" | "too_large" | "bad_response";

export class NetError extends Error {
  constructor(readonly kind: FetchFailure, message: string, readonly cause_code?: string) {
    super(message);
  }
}

export function classify(error: unknown): NetError {
  if (error instanceof NetError) return error;
  const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return new NetError("timeout", "request timed out");
  if (e?.name === "AbortError") return new NetError("aborted", "request aborted");
  const causeMsg = String(e?.cause?.message ?? "");
  if (/redirect/i.test(causeMsg) || /redirect/i.test(String(e?.message ?? ""))) return new NetError("redirect", "unexpected redirect");
  const code = typeof e?.cause?.code === "string" ? e.cause.code.slice(0, 40) : undefined;
  return new NetError("network", "network error", code);
}

export async function boundedFetch(url: string, init: RequestInit, budget: Budget, cap = PER_CALL_TIMEOUT_MS): Promise<Response> {
  const timeout = budget.slot(cap);
  if (timeout === 0) throw new NetError("budget_exhausted", "no time left in this call's budget");
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw classify(error);
  }
}

/** Reads a text body with a byte cap (the response's own timeout signal still applies). */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new NetError("too_large", `response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    throw classify(error);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
