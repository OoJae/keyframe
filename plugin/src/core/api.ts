// Keyframe HTTP API v1 client (frozen-interfaces.md §7). The API is untrusted input: every response is parsed with
// a loose schema (fields may be added, never removed) and re-checked by the caller against chain math and the
// env allowlists. Ids are regex-validated before they reach a path, so nothing user-supplied is spliced raw.

import { type Quote, QuoteSchema } from "../protocol/index.js";
import type { Config } from "./config.js";
import { type Budget, describeNetError, fetchBounded, NetError, parseJson } from "./net.js";
import { ToolError } from "./result.js";
import { clean, quoted } from "./text.js";

export const API_CAP_MS = 3_500;
const MAX_API_BYTES = 256 * 1024;

export const QUOTE_ID_RE = /^q_[1-9A-HJ-NP-Za-km-z]{22}$/;
export const ORDER_ID_RE = /^o_[1-9A-HJ-NP-Za-km-z]{22}$/;
export const ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type ApiResponse = { status: number; json: unknown; headers: Headers; bytes: Uint8Array };

export async function apiRequest(
  cfg: Config,
  budget: Budget,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; capMs?: number } = {},
  what = "Keyframe's API",
): Promise<ApiResponse> {
  try {
    const res = await fetchBounded(
      `${cfg.apiBase}${path}`,
      {
        method: init.method ?? "GET",
        headers:
          init.body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      budget,
      { capMs: init.capMs ?? API_CAP_MS, maxBytes: MAX_API_BYTES },
    );
    return { status: res.status, json: parseJson(res.bytes), headers: res.headers, bytes: res.bytes };
  } catch (error) {
    if (error instanceof NetError) throw new ToolError(`${what} ${describeNetError(error)}.`);
    throw error;
  }
}

/** The backend's own error text, sanitized and quoted (it is data, not an instruction). */
export function backendMessage(json: unknown): string {
  if (typeof json !== "object" || json === null) return "";
  const j = json as { message?: unknown; error?: unknown };
  const text = typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : "";
  return text ? ` Keyframe said: ${quoted(text, 240)}.` : "";
}

/** Seconds to wait from a 429/503 (Retry-After header, else the body's retry_after_s), clamped to 1..3600. */
export function retryAfterS(res: ApiResponse): number | null {
  const header = res.headers.get("retry-after")?.trim() ?? "";
  const body = (res.json as { retry_after_s?: unknown } | null)?.retry_after_s;
  const n = /^[0-9]{1,6}$/.test(header) ? Number(header) : typeof body === "number" ? body : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(3600, Math.max(1, n)) : null;
}

/** HTTP 429 (processed: false): the request was not processed; nothing happened, so it can simply be retried. */
export function rateLimitedText(res: ApiResponse): string {
  const n = retryAfterS(res);
  return `Keyframe rate-limited this request (HTTP 429), so it was not processed; retry it ${n === null ? "in a little while" : `after ${n} s`}`;
}

/** Shared mapping of non-2xx API statuses to user-facing errors. */
export function apiFailure(res: ApiResponse, tail: string): ToolError {
  const said = backendMessage(res.json);
  if (res.status === 429) return new ToolError(`${rateLimitedText(res)}.${said} ${tail}`);
  switch (res.status) {
    case 400:
    case 422:
      return new ToolError(`Keyframe could not accept this request (HTTP ${res.status}).${said} ${tail}`);
    case 401:
    case 403:
      return new ToolError(`Keyframe refused access (HTTP ${res.status}); check the access_token.${said} ${tail}`);
    case 404:
      return new ToolError(`Keyframe has no record of that id (HTTP 404).${said} ${tail}`);
    case 409:
      return new ToolError(`Keyframe reports a conflict with the order's current state (HTTP 409).${said} ${tail}`);
    case 410:
      return new ToolError(`That quote has expired (HTTP 410); request a new quote.${said} ${tail}`);
    case 451:
      return new ToolError(`Keyframe cannot serve this wallet (HTTP 451, compliance screening).${said} ${tail}`);
    case 503:
      return new ToolError(
        `Keyframe is busy or at capacity (HTTP ${res.status}); try again in a few minutes.${said} ${tail}`,
      );
    default:
      return new ToolError(`Keyframe's API returned HTTP ${res.status}.${said} ${tail}`);
  }
}

export function parseQuote(json: unknown, tail: string): Quote {
  const r = QuoteSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue ? clean(issue.path.join("."), 60) : "";
    const where = path ? quoted(path, 60) : "(root)";
    throw new ToolError(`Keyframe returned a quote that does not match the frozen v1 format (at ${where}). ${tail}`);
  }
  return r.data;
}

export async function getQuote(cfg: Config, budget: Budget, quoteId: string, tail: string): Promise<Quote> {
  if (!QUOTE_ID_RE.test(quoteId)) throw new ToolError(`${quoted(quoteId, 40)} is not a Keyframe quote id. ${tail}`);
  const res = await apiRequest(cfg, budget, `/v1/quotes/${quoteId}`, {}, "Fetching the quote from Keyframe's API");
  if (res.status !== 200) throw apiFailure(res, tail);
  const quote = parseQuote(res.json, tail);
  if (quote.quote_id !== quoteId) throw new ToolError(`Keyframe returned a different quote than requested. ${tail}`);
  return quote;
}
