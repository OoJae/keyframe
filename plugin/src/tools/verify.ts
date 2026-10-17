// keyframe_verify. derive: pure and offline (the conformance sample; output depends only on the input). funding and
// delivery: the deal is resolved (argument > API, always re-hashed), then proven from Base (two RPCs) and the
// public, hash-addressed KFC1 storage, never from Keyframe's word.

import { type Address, type Hex, hexToBytes, keccak256 } from "viem";
import { getQuote } from "../core/api.js";
import { receiptRead, usdcTransferred } from "../core/chain.js";
import { type Check, checkLines, fail, pass, skip, verdictOf, warn } from "../core/checks.js";
import { loadConfig } from "../core/config.js";
import { derive, inputAddress, parseTerms, payoutSummary, shapeChecks, ZERO32 } from "../core/deal.js";
import { fetchManifest, ipfsCidOf, manifestUrl, sourcesOf, verifyChunks } from "../core/delivery.js";
import { envelopeOf } from "../core/envelope.js";
import { Budget } from "../core/net.js";
import { type Snapshot, snapshot } from "../core/onchain.js";
import { boundSpec, type Resolved, resolveOrder, SETTLING_TEXT } from "../core/resolve.js";
import { dataResult, guarded, NOTHING_MOVED, ToolError } from "../core/result.js";
import { shortAddr, shortHash, usdc, utc } from "../core/text.js";
import { type Spec, Status, sha256Hex } from "../protocol/index.js";
import { VerifyInput, type VerifyInputT, VerifyOutput } from "../schemas.js";
import { COPY } from "./copy.js";
import { defineTool } from "./define.js";

function header(mode: string, verdict: string, envelope: string): string {
  return `Keyframe verify (${mode}): ${verdict.toUpperCase()} · envelope ${envelope}`;
}

/** Pure: no clock, no env, no network. */
export function deriveOnly(input: VerifyInputT) {
  const t = parseTerms(input.terms);
  const factory = inputAddress(input.factory, "factory");
  const vaultImpl = input.vault_impl === undefined ? undefined : inputAddress(input.vault_impl, "vault_impl");
  const d = derive(t, factory, vaultImpl);
  const checks: Check[] = [
    pass("terms_hash", `deal hash (EIP-712 Terms under factory ${shortAddr(factory)}): ${d.termsHash}`),
    pass(
      "escrow_address",
      `escrow address = CREATE2(factory, termsHash, EIP-1167 clone of ${shortAddr(d.derivation.vault_impl)}): ${d.escrow}`,
    ),
    ...shapeChecks(t),
  ];
  if (input.terms_hash !== undefined) {
    checks.push(
      input.terms_hash.toLowerCase() === d.termsHash
        ? pass("claimed_terms_hash", "the supplied terms_hash equals the recomputed one")
        : fail("claimed_terms_hash", `the supplied terms_hash ${input.terms_hash} is not the hash of these terms`),
    );
  }
  if (input.escrow !== undefined) {
    checks.push(
      input.escrow.toLowerCase() === d.escrow.toLowerCase()
        ? pass("claimed_escrow", "the supplied escrow address equals the recomputed one")
        : fail("claimed_escrow", `the supplied escrow ${input.escrow} is NOT the address derived from these terms`),
    );
  }
  if (vaultImpl !== undefined) {
    const nonce1 = derive(t, factory).derivation.vault_impl;
    checks.push(
      nonce1 === vaultImpl
        ? pass("vault_impl", "vault_impl is the factory's first contract (CREATE nonce 1)")
        : warn(
            "vault_impl",
            `vault_impl differs from the factory's first contract ${nonce1}; Keyframe factories always use nonce 1`,
          ),
    );
  }
  const payout = payoutSummary(t);
  const verdict = verdictOf(checks);
  const text = [
    `${header("derive", verdict, "UNKNOWN")} (offline: escrow math only, no chain reads)`,
    `Deal hash ${d.termsHash}`,
    `Escrow (sealed envelope) ${d.escrow}`,
    `Payout rule: ${payout.text}.`,
    checkLines(checks),
    "Next: keyframe_verify with mode funding (is the money sealed?) or delivery (is the key published and the file intact?).",
  ].join("\n");
  return dataResult(text, {
    mode: "derive",
    verdict,
    envelope: "UNKNOWN",
    summary: `${header("derive", verdict, "UNKNOWN")}. Escrow ${d.escrow}; deal hash ${d.termsHash}.`,
    terms_source: "argument",
    terms_hash: d.termsHash,
    escrow: d.escrow,
    derivation: d.derivation,
    payout: { at_due: payout.at_due, at_deadline: payout.at_deadline },
    checks,
    onchain: null,
    delivery: null,
    next: null,
  });
}

function rpcCheck(s: Snapshot): Check {
  if (s.rpc.responded === 0) return skip("base_rpcs", "no Base RPC answered; nothing on-chain could be checked");
  if (!s.view.consistent)
    return skip(
      "base_rpcs",
      `the ${s.rpc.responded} Base RPCs that answered DISAGREE (one may lag); check again shortly`,
    );
  if (s.orderSeen < 2)
    return skip("base_rpcs", `only ${s.orderSeen} of ${s.rpc.configured} Base RPCs answered; not cross-checked`);
  return pass("base_rpcs", `${s.orderSeen} independent Base RPCs agree`);
}

function onchainChecks(r: Resolved, s: Snapshot): Check[] {
  const checks: Check[] = [rpcCheck(s)];
  if (s.code === "other")
    checks.push(fail("escrow_code", "unexpected contract code at the escrow address (not a Keyframe clone)"));
  else if (s.code === "eip1167")
    checks.push(pass("escrow_code", "the escrow is a Keyframe EIP-1167 clone (deployed when money left it)"));
  else if (s.code === "none")
    checks.push(pass("escrow_code", "no code at the escrow address yet (the address itself is the deal)"));
  const o = s.order;
  if (o && r.terms && o.status !== Status.None) {
    const same = o.buyer.toLowerCase() === r.terms.buyer.toLowerCase() && Number(o.deadline) === r.terms.deadline;
    checks.push(
      same
        ? pass(
            "registered_deal",
            `registered on Base for buyer ${shortAddr(o.buyer)} with deadline ${utc(Number(o.deadline))}`,
          )
        : fail("registered_deal", "the on-chain record's buyer or deadline differs from these terms"),
    );
  }
  return checks;
}

async function funding(r: Resolved, input: VerifyInputT, budget: Budget, rpcUrls: string[]) {
  const txHash = (input.tx_hash ?? r.paid?.funding_tx)?.toLowerCase() as Hex | undefined;
  const extra = txHash ? [receiptRead(txHash)] : [];
  const s = await snapshot(rpcUrls, budget, r.factory, r.termsHash, r.escrow, extra);
  const amount = r.terms?.amount ?? r.paid?.amount;
  const checks = [...r.checks, ...onchainChecks(r, s)];
  // L3: a receipt counts only when at least two Base RPCs return the same one; a single RPC could fabricate it.
  const rcv = txHash ? s.rpc.get(receiptRead(txHash)) : null;
  const receipt = rcv && rcv.seen >= 2 && rcv.agree ? rcv.value : undefined;
  const receiptUnsettled = rcv !== null && rcv.seen > 0 && receipt === undefined;
  const o = s.order;
  if (!o || s.balance === undefined) {
    checks.push(skip("funded", "the escrow could not be read on Base"));
  } else if (o.status >= Status.Released) {
    checks.push(
      pass(
        "funded",
        `the escrow was funded and has settled (${["", "", "", "key published", "refunded", "voided", "rejected"][o.status]}): ${usdc(o.toSeller)} USDC to the studio, ${usdc(o.toBuyer)} USDC back to the buyer`,
      ),
    );
    if (amount !== undefined && o.toSeller > amount)
      checks.push(fail("payout_cap", "the studio was paid more than the deal amount"));
  } else if (amount === undefined) {
    checks.push(skip("funded", `the escrow holds ${usdc(s.balance)} USDC; the deal amount is unknown`));
  } else if (s.balance >= amount) {
    checks.push(
      pass(
        "funded",
        `${usdc(s.balance)} USDC is sealed at ${shortAddr(r.escrow)}${o.status === Status.None ? " (on-chain registration pending)" : ", registered on Base"}`,
      ),
    );
  } else if (r.paid?.charged === "unknown") {
    // Keyframe's paid path does not know the outcome yet (still settling): neither sealed nor failed.
    checks.push(
      skip(
        "funded",
        `not sealed yet: Keyframe reports the payment as still settling (charged "unknown"); the escrow holds ${usdc(s.balance)} of ${usdc(amount)} USDC. Do not pay again; check again shortly`,
      ),
    );
  } else if (txHash && o.status === Status.None && (receipt === null || receiptUnsettled)) {
    // The paid response may say funding "pending" (ADR-012): its transaction is broadcast but not mined yet. That is
    // not sealed and not verified, but not a failed payment either; telling the agent "failed" invites a second payment.
    checks.push(
      skip(
        "funded",
        `not sealed yet: transaction ${shortHash(txHash)} is not on Base yet and the escrow holds ${usdc(s.balance)} of ${usdc(amount)} USDC; check again in a few seconds`,
      ),
    );
  } else {
    checks.push(fail("funded", `the escrow holds ${usdc(s.balance)} of ${usdc(amount)} USDC: not (fully) paid`));
  }
  if (txHash && rcv) {
    const rc = receipt;
    const buyer = r.terms?.buyer;
    if (rcv.seen === 0) checks.push(skip("funding_tx", "the funding transaction could not be read"));
    else if (rc === undefined)
      checks.push(
        skip(
          "funding_tx",
          `transaction ${shortHash(txHash)} is not confirmed by 2 agreeing Base RPCs (${rcv.seen} answered${rcv.agree ? "" : " and they DISAGREE"}); check again shortly`,
        ),
      );
    else if (rc === null) checks.push(skip("funding_tx", `transaction ${shortHash(txHash)} is not on Base (yet)`));
    else if (rc.status !== "success") checks.push(fail("funding_tx", `transaction ${shortHash(txHash)} reverted`));
    else if (!buyer || amount === undefined)
      checks.push(skip("funding_tx", "succeeded; the buyer and amount are unknown without terms"));
    else {
      const moved = usdcTransferred(rc, buyer, r.escrow);
      checks.push(
        moved >= amount
          ? pass(
              "funding_tx",
              `transaction ${shortHash(txHash)} moved ${usdc(moved)} USDC from the buyer to the escrow`,
            )
          : fail(
              "funding_tx",
              `transaction ${shortHash(txHash)} moved ${usdc(moved)} USDC from the buyer to the escrow, not ${usdc(amount)}`,
            ),
      );
    }
  }
  return { s, checks, amount };
}

async function delivery(r: Resolved, input: VerifyInputT, budget: Budget, cfg: ReturnType<typeof loadConfig>) {
  const quoteFetch =
    !r.spec && (input.quote_id ?? r.paid?.quote_id) && budget.remaining() > 7_000
      ? getQuote(cfg, budget, (input.quote_id ?? r.paid?.quote_id) as string, NOTHING_MOVED).catch(() => null)
      : Promise.resolve(null);
  const [s, q] = await Promise.all([snapshot(cfg.rpcUrls, budget, r.factory, r.termsHash, r.escrow), quoteFetch]);
  // M3: a brief only counts when it hashes to the deal's specHash (resolveOrder applies the same rule).
  const spec: Spec | null = r.spec ?? (await boundSpec(q?.spec, r.terms));
  const checks = [...r.checks, ...onchainChecks(r, s)];
  const o = s.order;
  let mediaOut: { width: number; height: number; duration_ms: number } | null = null;
  let deliveryOut: Record<string, unknown> | null = null;
  if (!o) {
    checks.push(skip("key_published", "the escrow factory's record could not be read on Base"));
    return { s, checks, deliveryOut, mediaOut };
  }
  if (o.status !== Status.Released) {
    const env = envelopeOf(o.status, s.balance, r.terms?.amount);
    checks.push(skip("key_published", `not delivered yet: ${env.envelope} (${env.meaning})`));
    return { s, checks, deliveryOut, mediaOut };
  }
  const key = o.key;
  const mh = o.manifestHash;
  checks.push(
    pass("key_published", `the key to the file is published on Base and the studio was paid ${usdc(o.toSeller)} USDC`),
  );
  if (r.terms) {
    checks.push(
      keccak256(key) === r.terms.keyHash.toLowerCase()
        ? pass("key_matches_deal", "keccak256(published key) equals the keyHash committed in the deal")
        : fail("key_matches_deal", "the published key does not match the deal's keyHash"),
    );
    if (r.terms.reviewWindow === 0 && r.terms.contentHash !== ZERO32) {
      checks.push(
        mh === r.terms.contentHash.toLowerCase()
          ? pass(
              "file_matches_deal",
              "the released file is exactly the one committed when you paid (manifest hash = contentHash)",
            )
          : fail("file_matches_deal", "the released manifest hash differs from the deal's contentHash"),
      );
    }
    if (o.toSeller > r.terms.amount) checks.push(fail("payout_cap", "the studio was paid more than the deal amount"));
  }

  const sources = sourcesOf(cfg, mh, ipfsCidOf(r.quote, q, r.order));
  const { manifest, check } = await fetchManifest(cfg, budget, mh, sources);
  checks.push(check);
  if (!manifest) return { s, checks, deliveryOut, mediaOut };
  if (r.terms && manifest.salt !== r.terms.salt.toLowerCase()) {
    checks.push(fail("manifest_salt", "the manifest's salt is not this deal's salt"));
    return { s, checks, deliveryOut, mediaOut };
  }

  const kBuyer = (input.k_buyer ?? r.paid?.k_buyer ?? ZERO32).toLowerCase() as Hex;
  const isPrivate = spec?.delivery === "private";
  if (isPrivate && spec?.kBuyerHash) {
    if (kBuyer === ZERO32) {
      checks.push(
        fail(
          "k_buyer",
          r.paid?.secrets_withheld
            ? "this is a private order and the paid response withholds k_buyer (a later replay): recover it with keyframe_orders (sign in with the buyer wallet), then pass k_buyer"
            : "this is a private order: pass k_buyer from the paid response (or keyframe_orders) to decrypt",
        ),
      );
      return { s, checks, deliveryOut: summaryOut(cfg, mh, manifest, 0), mediaOut };
    }
    const h = await sha256Hex(hexToBytes(kBuyer));
    if (h !== spec.kBuyerHash.toLowerCase()) {
      checks.push(fail("k_buyer", "the k_buyer supplied is not the one committed in the brief (sha256 mismatch)"));
      return { s, checks, deliveryOut: summaryOut(cfg, mh, manifest, 0), mediaOut };
    }
    checks.push(pass("k_buyer", "your private key share matches the hash committed in the brief"));
  }
  const res = await verifyChunks(sources, budget, manifest, key, kBuyer, {
    maxChunks: input.max_chunks ?? 64,
    spec,
    privateHint: !spec && kBuyer === ZERO32,
  });
  checks.push(...res.checks);
  if (!spec)
    checks.push(
      skip(
        "matches_brief",
        "no brief (spec) that hashes to the deal's specHash was available, so resolution and length were checked against the manifest only",
      ),
    );
  if (res.media) mediaOut = { width: res.media.width, height: res.media.height, duration_ms: res.media.durationMs };
  deliveryOut = { ...summaryOut(cfg, mh, manifest, res.chunksVerified), media: mediaOut };
  return { s, checks, deliveryOut, mediaOut };
}

function summaryOut(
  cfg: ReturnType<typeof loadConfig>,
  mh: Hex,
  m: { chunks: number; size: number },
  verified: number,
) {
  return {
    manifest_hash: mh,
    chunks_total: m.chunks,
    chunks_verified: verified,
    bytes_total: m.size,
    media: null,
    manifest_url: manifestUrl(cfg, mh),
  };
}

export const verifyTool = defineTool({
  name: "keyframe_verify",
  ...COPY.keyframe_verify,
  inputSchema: VerifyInput,
  outputSchema: VerifyOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: (input) =>
    guarded(async () => {
      if (input.mode === "derive") return deriveOnly(input);
      const cfg = loadConfig();
      const budget = new Budget();
      const r = await resolveOrder(cfg, budget, input, NOTHING_MOVED);
      if (input.mode === "funding") {
        const { s, checks } = await funding(r, input, budget, cfg.rpcUrls);
        return finish("funding", r, s, checks, null);
      }
      const { s, checks, deliveryOut } = await delivery(r, input, budget, cfg);
      return finish("delivery", r, s, checks, deliveryOut);
    }, NOTHING_MOVED),
});

function finish(
  mode: "funding" | "delivery",
  r: Resolved,
  s: Snapshot,
  checks: Check[],
  deliveryOut: Record<string, unknown> | null,
) {
  if (checks.length > 60) throw new ToolError("Too many checks to report.");
  const verdict = verdictOf(checks);
  const env = envelopeOf(s.order?.status, s.balance, r.terms?.amount ?? r.paid?.amount);
  const ref = r.paid?.order_id ? { order_id: r.paid.order_id } : r.quote ? { quote_id: r.quote.quote_id } : {};
  const settling = r.paid?.charged === "unknown" && env.envelope === "NOT SEALED";
  const next = settling
    ? {
        tool: "keyframe_status",
        input: { quote_id: r.quote?.quote_id ?? r.paid?.quote_id ?? null, wait_s: 6 },
        note: "The payment is still being settled. Do not pay again; poll keyframe_status, then verify funding.",
      }
    : env.envelope === "SEALED" || env.envelope === "NOT SEALED"
      ? {
          tool: "keyframe_status",
          input: { ...ref, wait_s: 6 },
          note: "Rendering or awaiting payment; check progress, then verify delivery once the key is published.",
        }
      : env.envelope === "KEY PUBLISHED" && mode === "funding"
        ? {
            tool: "keyframe_verify",
            input: { mode: "delivery", ...ref },
            note: "The key is published; verify the file itself.",
          }
        : env.envelope === "IN REVIEW"
          ? { tool: "keyframe_review", input: {}, note: "Studio review: accept, ask for changes or reject." }
          : null;
  const lines = [
    header(mode, verdict, env.envelope),
    `Envelope ${r.escrow}: ${env.meaning}. Terms source: ${r.source === "api" ? "Keyframe's API, re-hashed here" : r.source}.`,
    checkLines(checks),
  ];
  if (deliveryOut && typeof deliveryOut.manifest_url === "string") {
    lines.push(
      `Encrypted copy: ${deliveryOut.manifest_url} (chunks alongside). The key is public on Base, so this file stays openable even without Keyframe's server${r.spec?.delivery === "private" ? " (private order: with your k_buyer)" : ""}. Keyframe's download link is in keyframe_status.`,
    );
  }
  if (r.paid?.charged === "unknown") lines.push(SETTLING_TEXT);
  if (r.paid?.error === "settlement_recording_delayed") {
    lines.push(
      "Keyframe reports the payment as settled (charged: true) while the order is still being recorded. Do not pay again; check keyframe_status in a minute.",
    );
  }
  if (r.paid?.order_id && !r.paid.access_token) {
    lines.push(
      `The paid response carries no access_token${r.paid.secrets_withheld ? " or k_buyer (secrets_withheld: Keyframe returns them only right after settlement)" : ""}. To read a private order or decrypt its file, recover them with keyframe_orders (sign in with the buyer wallet). Nothing needs to be paid again.`,
    );
  }
  if (next) lines.push(`Next: ${next.tool} (${next.note})`);
  return dataResult(lines.join("\n"), {
    mode,
    verdict,
    envelope: env.envelope,
    summary: `${header(mode, verdict, env.envelope)}. ${env.meaning}.`.slice(0, 800),
    terms_source: r.source,
    terms_hash: r.termsHash,
    escrow: r.escrow as Address,
    derivation: r.derived?.derivation ?? null,
    payout: r.terms ? (({ at_due, at_deadline }) => ({ at_due, at_deadline }))(payoutSummary(r.terms)) : null,
    checks,
    onchain: s.view,
    delivery: deliveryOut,
    next,
  });
}
