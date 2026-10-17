// Strict parser for a single x402 challenge (v2 PAYMENT-REQUIRED header, or v1 JSON body; never both).

import { createHash } from "node:crypto";
import * as z from "zod/v4";

import { ADDRESS, ATOMIC } from "./config.js";

const V2Accept = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string().regex(ADDRESS),
  amount: z.string().regex(ATOMIC),
  payTo: z.string().regex(ADDRESS),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const V2Challenge = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string() }).passthrough().optional(),
  accepts: z.array(z.unknown()),
}).passthrough();

const V1Accept = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string().regex(ADDRESS),
  maxAmountRequired: z.string().regex(ATOMIC),
  payTo: z.string().regex(ADDRESS),
  maxTimeoutSeconds: z.number().int().positive(),
  resource: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const V1Challenge = z.object({ x402Version: z.literal(1), accepts: z.array(z.unknown()) }).passthrough();

export interface Challenge {
  version: 1 | 2;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resourceUrl: string | null;
  extra: Record<string, unknown> | null;
  /** sha256 of the raw PAYMENT-REQUIRED header (v2) or of the raw body (v1). */
  sha256: string;
}

export type ParseResult = { ok: true; challenge: Challenge } | { ok: false; reason: string };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function decodeHeader(value: string): unknown {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("not base64");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

export function parseChallenge(status: number, headerValue: string | null, bodyText: string): ParseResult {
  if (status !== 402) return { ok: false, reason: `expected HTTP 402 from the order URL, got ${status}` };
  let body: unknown = null;
  if (bodyText.trim()) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }
  const bodyLooksV1 = !!body && typeof body === "object" && "x402Version" in (body as object) && "accepts" in (body as object);
  const header = headerValue?.trim() || null;
  if (header && bodyLooksV1) return { ok: false, reason: "mixed x402 versions in one response (header and body challenge)" };

  if (header) {
    let decoded: unknown;
    try {
      decoded = decodeHeader(header);
    } catch {
      return { ok: false, reason: "PAYMENT-REQUIRED header is not base64 JSON" };
    }
    const parsed = V2Challenge.safeParse(decoded);
    if (!parsed.success) return { ok: false, reason: "PAYMENT-REQUIRED header is not an x402 v2 challenge" };
    if (parsed.data.accepts.length !== 1) return { ok: false, reason: `expected exactly one accepts entry, got ${parsed.data.accepts.length}` };
    const entry = V2Accept.safeParse(parsed.data.accepts[0]);
    if (!entry.success) return { ok: false, reason: "v2 accepts entry is malformed" };
    const a = entry.data;
    return {
      ok: true,
      challenge: {
        version: 2, scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo,
        maxTimeoutSeconds: a.maxTimeoutSeconds, resourceUrl: parsed.data.resource?.url ?? null, extra: a.extra ?? null,
        sha256: sha256(header),
      },
    };
  }

  if (bodyLooksV1) {
    const parsed = V1Challenge.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "402 body is not an x402 v1 challenge" };
    if (parsed.data.accepts.length !== 1) return { ok: false, reason: `expected exactly one accepts entry, got ${parsed.data.accepts.length}` };
    const entry = V1Accept.safeParse(parsed.data.accepts[0]);
    if (!entry.success) return { ok: false, reason: "v1 accepts entry is malformed" };
    const a = entry.data;
    return {
      ok: true,
      challenge: {
        version: 1, scheme: a.scheme, network: a.network, asset: a.asset, amount: a.maxAmountRequired, payTo: a.payTo,
        maxTimeoutSeconds: a.maxTimeoutSeconds, resourceUrl: a.resource ?? null, extra: a.extra ?? null,
        sha256: sha256(bodyText),
      },
    };
  }
  return { ok: false, reason: "402 response carries no x402 challenge (no PAYMENT-REQUIRED header, no v1 body)" };
}
