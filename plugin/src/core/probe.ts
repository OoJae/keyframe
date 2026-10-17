// Pre-fetch of the live 402 at the x402 resource, the same request shape PayBox's unpaid probe sends (POST, no
// body). Asserts a single wire version and exactly one exact / eip155:8453 / Base-USDC requirement whose payTo is
// the locally derived escrow and whose amount is exactly T.amount (frozen-interfaces.md §7, §8).

import { type Address, type Hex, isAddressEqual } from "viem";
import {
  CAIP2,
  type NormalizedAccept,
  normalizeAccept,
  type PaymentRequired,
  parsePaymentRequired,
  sha256Hex,
  USDC,
} from "../protocol/index.js";
import { apiRequest, backendMessage } from "./api.js";
import { type Check, fail, pass } from "./checks.js";
import type { Config } from "./config.js";
import type { Budget } from "./net.js";
import { ToolError } from "./result.js";
import { clean, shortAddr, usdc } from "./text.js";

export type ProbeOk = { ok: true; check: Check; version: 1 | 2; accept: NormalizedAccept; sha256: Hex; url: string };
export type ProbeFail = { ok: false; check: Check; reason: "paid" | "expired" | "unavailable" | "invalid" | "network" };
export type Probe = ProbeOk | ProbeFail;

const PROBE_CAP_MS = 3_000;

export const orderUrl = (cfg: Config, quoteId: string): string => `${cfg.apiBase}/v1/orders/${quoteId}`;

export async function probe402(
  cfg: Config,
  budget: Budget,
  quoteId: string,
  expect: { escrow: Address; amount: bigint },
): Promise<Probe> {
  const url = orderUrl(cfg, quoteId);
  const id = "live_402";
  let res: Awaited<ReturnType<typeof apiRequest>>;
  try {
    res = await apiRequest(
      cfg,
      budget,
      `/v1/orders/${quoteId}`,
      { method: "POST", capMs: PROBE_CAP_MS },
      "The payment request",
    );
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, reason: "network", check: fail(id, error.message) };
    throw error;
  }
  const said = backendMessage(res.json);
  if (res.status === 409 || res.status === 200) {
    return {
      ok: false,
      reason: "paid",
      check: fail(id, `the order URL says this quote is already paid (HTTP ${res.status}).${said}`),
    };
  }
  if (res.status === 410)
    return { ok: false, reason: "expired", check: fail(id, `the quote has expired (HTTP 410).${said}`) };
  if (res.status === 451 || res.status === 503 || res.status === 429) {
    return {
      ok: false,
      reason: "unavailable",
      check: fail(id, `Keyframe cannot take this order now (HTTP ${res.status}).${said}`),
    };
  }

  let pr: PaymentRequired;
  try {
    pr = parsePaymentRequired({
      status: res.status,
      headers: res.headers,
      bodyText: new TextDecoder().decode(res.bytes),
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      reason: "invalid",
      check: fail(
        id,
        `the order URL did not return one well-formed x402 payment request (${clean(code, 40) || "unparseable"}).`,
      ),
    };
  }

  const all = pr.accepts.map(normalizeAccept);
  const base = all.filter(
    (a) =>
      a.scheme === "exact" &&
      a.network === CAIP2 &&
      /^0x[0-9a-fA-F]{40}$/.test(a.asset) &&
      isAddressEqual(a.asset as Address, USDC),
  );
  const problems: string[] = [];
  if (base.length !== 1) {
    const seen = all
      .map((a) => `${clean(a.scheme, 20)}/${clean(a.network, 40)}/${shortAddr(clean(a.asset, 64))}`)
      .join(", ");
    problems.push(`expected exactly one exact / Base / USDC requirement, found ${base.length} (${seen})`);
  }
  const accept = base[0];
  if (accept) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(accept.payTo) || !isAddressEqual(accept.payTo as Address, expect.escrow)) {
      problems.push(`it pays ${clean(accept.payTo, 64)}, not the escrow ${expect.escrow}`);
    }
    if (accept.amount !== expect.amount.toString()) {
      problems.push(`it asks ${clean(accept.amount, 80)} atomic USDC, not the deal's ${expect.amount}`);
    }
  }
  if (problems.length > 0 || !accept) {
    return { ok: false, reason: "invalid", check: fail(id, `live payment request rejected: ${problems.join("; ")}.`) };
  }

  const wire = pr.version === 2 ? (res.headers.get("payment-required") ?? "") : new TextDecoder().decode(res.bytes);
  const sha256 = await sha256Hex(wire.trim());
  const resourceNote =
    pr.resource && pr.resource.url !== url ? ` Note: it names resource ${clean(pr.resource.url, 200)}.` : "";
  return {
    ok: true,
    version: pr.version,
    accept,
    sha256,
    url,
    check: pass(
      id,
      `live payment request (x402 v${pr.version}) pays exactly ${usdc(expect.amount)} USDC to ${shortAddr(expect.escrow)}; sha256 ${sha256.slice(0, 18)}…${resourceNote}`,
    ),
  };
}
