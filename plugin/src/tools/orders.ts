// keyframe_orders: new-chat recovery. Stage 1 fetches a SIWE challenge (checked by core/siwe.ts) plus the public
// order list; stage 2 checks the signature locally (it must recover to the address) and exchanges it for the
// buyer's orders with fresh access tokens and k_buyer.

import { type Address, getAddress, type Hex, isAddressEqual, recoverMessageAddress } from "viem";
import { apiFailure, apiRequest } from "../core/api.js";
import { loadConfig } from "../core/config.js";
import { Budget } from "../core/net.js";
import { dataResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { checkSiwe } from "../core/siwe.js";
import { capRecord, capRecords, nowSeconds, quoted, shortAddr, utc } from "../core/text.js";
import { OrdersInput, OrdersOutput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

const MAX_ORDERS = 50;
const ID = /^o_[1-9A-HJ-NP-Za-km-z]{22}$/;
/** L1: one listed order is a handful of short fields; the whole list stays far below the stdout limit. */
const MAX_ORDER_BYTES = 4 * 1024;
const MAX_LIST_BYTES = 96 * 1024;
const ORDER_CAPS = { maxString: 300, maxArray: 10, maxKeys: 30, maxDepth: 3 };

function orderList(json: unknown, withSecrets: boolean): Record<string, unknown>[] {
  const raw = (json as { orders?: unknown } | null)?.orders;
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of raw.slice(0, MAX_ORDERS)) {
    if (typeof item !== "object" || item === null) continue;
    const o = capRecord(item, ORDER_CAPS, MAX_ORDER_BYTES) as Record<string, unknown> | null;
    if (!o || typeof o.order_id !== "string" || !ID.test(o.order_id)) continue;
    if (!withSecrets) {
      delete o.access_token;
      delete o.k_buyer;
    } else {
      if (
        o.access_token !== undefined &&
        !(typeof o.access_token === "string" && /^[A-Za-z0-9_-]{43}$/.test(o.access_token))
      )
        delete o.access_token;
      if (
        o.k_buyer !== undefined &&
        o.k_buyer !== null &&
        !(typeof o.k_buyer === "string" && /^0x[0-9a-fA-F]{64}$/.test(o.k_buyer))
      )
        delete o.k_buyer;
    }
    out.push(o);
  }
  return capRecords(out, MAX_ORDER_BYTES, MAX_LIST_BYTES);
}

const listLine = (orders: Record<string, unknown>[]) =>
  orders
    .slice(0, 10)
    .map((o) => `- ${o.order_id}: ${quoted(o.status ?? "unknown", 40)}`)
    .join("\n");

export const ordersTool = defineTool({
  name: "keyframe_orders",
  ...COPY.keyframe_orders,
  inputSchema: OrdersInput,
  outputSchema: OrdersOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: (input) =>
    guarded(async () => {
      const cfg = loadConfig();
      const budget = new Budget();
      const address = getAddress(input.address) as Address;
      const now = nowSeconds();

      if (input.signature === undefined) {
        const [challenge, list] = await Promise.all([
          apiRequest(
            cfg,
            budget,
            "/v1/auth/siwe/challenge",
            { method: "POST", body: { address } },
            "Requesting the sign-in message",
          ),
          apiRequest(cfg, budget, `/v1/orders?buyer=${address}`, {}, "Listing orders").catch(() => null),
        ]);
        if (challenge.status !== 200) throw apiFailure(challenge, NOTHING_MOVED);
        const message = (challenge.json as { message?: unknown } | null)?.message;
        if (typeof message !== "string") throw new ToolError(`Keyframe returned no sign-in message. ${NOTHING_MOVED}`);
        const siwe = checkSiwe(message, { apiBase: cfg.apiBase, address, now, forSubmit: false });
        const pub = list && list.status === 200 ? orderList(list.json, false) : [];
        return dataResult(
          [
            `Sign-in to Keyframe for ${address}${pub.length ? ` (${pub.length} public order(s) found)` : ""}.`,
            pub.length ? listLine(pub) : "",
            `Checked by this plugin: the message signs in to ${siwe.domain} only, for this address, on Base, and expires at ${utc(siwe.expiresAt)}. Signing it moves no money.`,
            "Sign structuredContent.message exactly as returned with core request_wallet_sign (personal message) from that wallet, then call keyframe_orders again with address, message and signature.",
          ]
            .filter(Boolean)
            .join("\n"),
          {
            stage: "sign",
            address,
            message,
            sign_with: `core request_wallet_sign (EIP-191 personal message) from ${address}`,
            orders: pub,
            note: "Public list: ids and statuses only. Access links and private keys come after sign-in.",
            next: {
              tool: "keyframe_orders",
              input: { address },
              note: "Call again with this address plus message (unchanged) and the signature.",
            },
          },
        );
      }

      const message = input.message as string;
      checkSiwe(message, { apiBase: cfg.apiBase, address, now, forSubmit: true });
      let signer: Address;
      try {
        signer = await recoverMessageAddress({ message, signature: input.signature as Hex });
      } catch {
        throw new ToolError(`The signature is malformed. ${NOTHING_MOVED}`);
      }
      if (!isAddressEqual(signer, address)) {
        throw new ToolError(
          `The signature is from ${shortAddr(signer)}, not ${shortAddr(address)}; sign with that wallet. ${NOTHING_MOVED}`,
        );
      }
      const res = await apiRequest(
        cfg,
        budget,
        "/v1/auth/siwe/verify",
        {
          method: "POST",
          body: { address, message, signature: input.signature },
        },
        "Signing in",
      );
      if (res.status !== 200) throw apiFailure(res, NOTHING_MOVED);
      const orders = orderList(res.json, true);
      return dataResult(
        [
          `Signed in as ${address}: ${orders.length} Keyframe order(s).`,
          listLine(orders),
          "Each order carries its access_token (and k_buyer for private orders). Use them with keyframe_status and keyframe_verify; keep them private.",
        ]
          .filter(Boolean)
          .join("\n"),
        {
          stage: "signed_in",
          address,
          message: null,
          sign_with: null,
          orders,
          note: "Pass order_id and access_token to keyframe_status; pass k_buyer to keyframe_verify (mode delivery) for private orders.",
          next: orders[0]
            ? {
                tool: "keyframe_status",
                input: { order_id: orders[0].order_id },
                note: "Add that order's access_token.",
              }
            : null,
        },
      );
    }, NOTHING_MOVED),
});
