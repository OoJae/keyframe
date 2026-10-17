// Independent review of a backend quote before anything is payable: every field the money depends on is
// recomputed or cross-checked (Terms, spec hash, salt, derivation, allowlists, live 402, escrow state, wallet).
// A single "fail" makes the quote unpayable; proposal tools refuse to build anything from it.

import { type Address, type Hex, isAddressEqual } from "viem";
import { type Quote, saltOf, specHash, type Terms, termsFromJson } from "../protocol/index.js";
import { classifyEscrowCode, codeRead, type EscrowCode, orderRead, statusName, usdcRead } from "./chain.js";
import { type Check, fail, failed, pass, skip, warn } from "./checks.js";
import { type Config, findFactory } from "./config.js";
import { allowlistChecks, type Derived, dealBoundsCheck, derive, MAX_LOCK_S, shapeChecks, ZERO32 } from "./deal.js";
import { fetchManifest, ipfsCidOf, sourcesOf } from "./delivery.js";
import { type Link, linksOf } from "./links.js";
import type { Budget } from "./net.js";
import { type Probe, probe402 } from "./probe.js";
import { crossRead } from "./rpc.js";
import { checkStill, keyframeUrl } from "./still.js";
import { approxDuration, shortAddr, usdc, utc } from "./text.js";
import { chooseRoute, type Route, walletReads, walletView } from "./wallet.js";

/** Minimum time left on a quote for a proposal to be worth making (PayBox approval + payment). */
export const MIN_QUOTE_LEFT_S = 90;

export type EscrowState = {
  code: EscrowCode | null;
  balance: bigint | null;
  status: number | null;
  consistent: boolean;
};

export type QuoteReview = {
  quote: Quote;
  terms: Terms;
  derived: Derived;
  checks: Check[];
  fatal: Check[];
  probe: Probe | null;
  route: Route | null;
  escrow: EscrowState;
  /** True when the deal's buyer was compared with a wallet the agent supplied (not only with the quote's claim). */
  buyerChecked: boolean;
  /** Preview links that may be shown: only plain URLs on Keyframe's own hosts (else null). */
  preview: { still: string | null; video: string | null };
  /** Backend links on the quote (links[], e.g. the motion-preview page), own hosts only; shown in the card's text. */
  links: Link[];
};

/** What the caller already knows independently of the backend: the user's wallet and the deal it reviewed. */
export type Expected = { buyer?: Address; termsHash?: Hex };

const lc = (s: string) => s.toLowerCase();

/** Checks that need neither network nor RPC. `now` is unix seconds. */
export async function localQuoteChecks(cfg: Config, quote: Quote, now: number, expected: Expected = {}) {
  const t = termsFromJson(quote.terms);
  const checks: Check[] = [];
  const entry = findFactory(cfg, quote.factory);
  const derived = derive(t, quote.factory, entry?.vaultImpl);
  const expectBuyer = expected.buyer;

  // The API keeps a quote "final" while a payment for it settles, with payable: false (ADR-019): never pay twice.
  if (quote.status === "final" && (quote as { payable?: unknown }).payable === false) {
    checks.push(
      fail(
        "quote_final",
        "Keyframe reports a payment for this quote is already being settled (payable: false): do not pay again; poll keyframe_status",
      ),
    );
  } else if (quote.status === "final") checks.push(pass("quote_final", "the quote is final"));
  else if (quote.status === "draft")
    checks.push(skip("quote_final", "the key-frame preview is still rendering (draft quote)"));
  else checks.push(fail("quote_final", `the quote is ${quote.status}; it cannot be paid`));

  const buyerOk =
    isAddressEqual(quote.buyer, t.buyer) && (expectBuyer === undefined || isAddressEqual(expectBuyer, t.buyer));
  checks.push(
    buyerOk
      ? pass("buyer_matches", `refunds and change can only go to the buyer wallet ${shortAddr(t.buyer)}`)
      : fail("buyer_matches", `the deal's buyer ${shortAddr(t.buyer)} is not the requested buyer wallet`),
  );

  checks.push(
    isAddressEqual(derived.derivation.vault_impl, quote.vault_impl)
      ? pass(
          "vault_impl",
          `vault implementation ${shortAddr(derived.derivation.vault_impl)} = the factory's first contract`,
        )
      : fail(
          "vault_impl",
          `the quote names vault implementation ${shortAddr(quote.vault_impl)}, not ${shortAddr(derived.derivation.vault_impl)}`,
        ),
  );
  checks.push(
    lc(derived.termsHash) === lc(quote.terms_hash)
      ? pass("terms_hash", `deal hash recomputed locally: ${derived.termsHash}`)
      : fail("terms_hash", "the quote's terms_hash does not match the hash of its own terms"),
  );
  // H1: a payment must be for exactly the deal the user reviewed. The backend serves the quote again at payment
  // time; any change of price, deadline, refund wallet or brief changes the locally derived hash.
  if (expected.termsHash !== undefined) {
    checks.push(
      lc(derived.termsHash) === lc(expected.termsHash)
        ? pass("same_deal", "this is exactly the deal that was reviewed (same terms_hash)")
        : fail(
            "same_deal",
            `the deal changed since it was reviewed: its hash is now ${derived.termsHash}, not ${lc(expected.termsHash)}; the price, deadline, refund wallet or brief may differ. Review it again with keyframe_status (quote_id and buyer)`,
          ),
    );
  }
  checks.push(
    isAddressEqual(derived.escrow, quote.escrow)
      ? pass("escrow_address", `escrow address recomputed locally (CREATE2 from the deal): ${derived.escrow}`)
      : fail(
          "escrow_address",
          `the quote's escrow ${quote.escrow} is NOT the address derived from its terms (${derived.escrow})`,
        ),
  );
  checks.push(...shapeChecks(t), dealBoundsCheck(t), ...allowlistChecks(cfg, t, quote.factory, "pay"));

  checks.push(
    lc(saltOf(quote.quote_id)) === lc(t.salt)
      ? pass("salt", "the deal's salt is derived from this quote id (one quote, one deal)")
      : fail("salt", "the deal's salt is not keccak256(quote_id)"),
  );
  checks.push(
    BigInt(quote.price.atomic) === t.amount
      ? pass("price_matches_terms", `price ${usdc(t.amount)} USDC equals the escrowed amount`)
      : fail(
          "price_matches_terms",
          `quoted price ${usdc(quote.price.atomic)} differs from the escrowed amount ${usdc(t.amount)}`,
        ),
  );

  const sh = await specHash(quote.spec);
  const specProblems: string[] = [];
  if (sh !== lc(t.specHash) || sh !== lc(quote.spec_hash))
    specProblems.push("sha256(JCS(spec)) differs from the deal's specHash");
  if (!isAddressEqual(quote.spec.studio, t.seller))
    specProblems.push("the spec names a different studio than the payout address");
  if ((quote.spec.tier === "instant") !== (t.reviewWindow === 0))
    specProblems.push("the spec tier contradicts the deal's review window");
  if (quote.spec.delivery !== quote.delivery) specProblems.push("the spec's delivery mode differs from the quote's");
  if (quote.spec.tier !== quote.tier) specProblems.push("the spec's tier differs from the quote's");
  checks.push(
    specProblems.length === 0
      ? pass("spec_hash", "the brief you see (format, params, template, key frame) is exactly what the deal commits to")
      : fail("spec_hash", specProblems.join("; ")),
  );

  const timing: string[] = [];
  if (quote.deadline !== t.deadline) timing.push("the quote's deadline differs from the deal's");
  if (t.deadline <= now + 60) timing.push("the deadline has passed or is less than a minute away");
  if (t.deadline - now > MAX_LOCK_S) timing.push("the deadline is more than 7 days away (plugin safety bound)");
  if (quote.status === "final" && quote.quote_expires_at < now + MIN_QUOTE_LEFT_S) {
    timing.push("the quote expires in under 90 seconds; request a new quote");
  }
  checks.push(
    timing.length === 0
      ? pass(
          "deadline",
          `deadline ${utc(t.deadline)}: if the key is not published by then, the USDC can only return to the buyer`,
        )
      : fail("deadline", timing.join("; ")),
  );

  if (t.reviewWindow === 0 && quote.status === "final") {
    const mh = quote.content.manifest_hash;
    checks.push(
      t.contentHash !== ZERO32 && mh !== null && lc(mh) === lc(t.contentHash)
        ? pass("file_committed", "the deal commits to the exact encrypted file already rendered (manifest hash)")
        : fail("file_committed", "this Instant quote does not commit to its rendered file (contentHash)"),
    );
  }
  const still = quote.preview.still_sha256;
  const committed = quote.spec.keyframe?.stillSha256 ?? null;
  if (still !== null && committed !== null && lc(still) !== lc(committed)) {
    checks.push(fail("preview_matches_deal", "the preview's sha256 differs from the key frame committed in the spec"));
  }
  return { terms: t, derived, checks };
}

export async function reviewQuote(
  cfg: Config,
  budget: Budget,
  quote: Quote,
  opts: { now: number; expectBuyer?: Address; expectTermsHash?: Hex; live: boolean; wallet: boolean },
): Promise<QuoteReview> {
  const {
    terms: t,
    derived,
    checks,
  } = await localQuoteChecks(cfg, quote, opts.now, {
    buyer: opts.expectBuyer,
    termsHash: opts.expectTermsHash,
  });
  const escrow: EscrowState = { code: null, balance: null, status: null, consistent: true };
  const buyerChecked = opts.expectBuyer !== undefined;
  const preview = {
    still: keyframeUrl(cfg, quote.preview.still_url),
    video: keyframeUrl(cfg, quote.preview.video_url),
  };
  const links = linksOf(cfg, quote);
  const base = { quote, terms: t, derived, checks, escrow, buyerChecked, preview, links };
  if (!opts.live || quote.status !== "final") {
    return { ...base, fatal: failed(checks), probe: null, route: null };
  }

  const vaultImpl = derived.derivation.vault_impl;
  const factory = quote.factory as Address;
  const reads = [
    codeRead(derived.escrow),
    usdcRead(derived.escrow),
    orderRead(factory, derived.termsHash),
    ...(opts.wallet ? walletReads(t.buyer) : []),
  ];
  const stillCommitted = (quote.spec.keyframe?.stillSha256 ?? quote.preview.still_sha256 ?? null) as Hex | null;
  const instantFile = t.reviewWindow === 0 && t.contentHash !== ZERO32 ? t.contentHash : null;
  const [probe, rpc, stillCheck, file] = await Promise.all([
    probe402(cfg, budget, quote.quote_id, { escrow: derived.escrow, amount: t.amount }),
    crossRead(cfg.rpcUrls, reads, budget),
    checkStill(cfg, budget, quote.preview.still_url, stillCommitted),
    instantFile
      ? fetchManifest(cfg, budget, instantFile, sourcesOf(cfg, instantFile, ipfsCidOf(quote)))
      : Promise.resolve(null),
  ]);
  checks.push(probe.check);
  if (!checks.some((c) => c.id === "preview_matches_deal")) checks.push(stillCheck);
  if (file) checks.push(fileAvailableCheck(file, quote));

  const code = rpc.get(codeRead(derived.escrow));
  const bal = rpc.get(usdcRead(derived.escrow));
  const ord = rpc.get(orderRead(factory, derived.termsHash));
  escrow.code = code.value === undefined ? null : classifyEscrowCode(code.value, vaultImpl);
  escrow.balance = bal.value ?? null;
  escrow.status = ord.value?.status ?? null;
  escrow.consistent = code.agree && bal.agree && ord.agree;
  // Fail if ANY answering RPC sees the deal registered or the escrow already funded: paying twice is never wanted.
  const anyStatus = ord.values.find((o) => o.status !== 0)?.status;
  const maxBal = bal.values.reduce<bigint | undefined>((m, b) => (m === undefined || b > m ? b : m), undefined);
  if (ord.value === undefined || maxBal === undefined) {
    checks.push(
      skip("escrow_unused", "could not read the escrow on Base; the live payment-request check above still applies"),
    );
  } else if (anyStatus !== undefined) {
    checks.push(fail("escrow_unused", `this deal is already ${statusName(anyStatus)} on Base; do not pay it again`));
  } else if (maxBal >= t.amount) {
    checks.push(
      fail(
        "escrow_unused",
        `the escrow already holds ${usdc(maxBal)} USDC; it looks paid. Check keyframe_status before paying again`,
      ),
    );
  } else if (!escrow.consistent) {
    checks.push(warn("escrow_unused", "the configured Base RPCs disagree about the escrow; re-check before paying"));
  } else if (maxBal > 0n) {
    checks.push(
      warn(
        "escrow_unused",
        `the escrow already holds ${usdc(maxBal)} USDC; anything above the price returns to the buyer`,
      ),
    );
  } else {
    checks.push(
      pass(
        "escrow_unused",
        `nothing is deployed at ${shortAddr(derived.escrow)} yet and it holds no USDC (${rpc.responded} of ${rpc.configured} Base RPCs agree)`,
      ),
    );
  }

  const route = opts.wallet ? chooseRoute(cfg, walletView(rpc, t.buyer, t.amount), t.amount) : null;
  return { ...base, fatal: failed(checks), probe, route };
}

const ASPECT_SIZE: Record<string, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "16:9": [1920, 1080],
};

/** Render-before-pay: the committed encrypted master should already be public, and match the brief. */
function fileAvailableCheck(file: Awaited<ReturnType<typeof fetchManifest>>, quote: Quote): Check {
  const id = "file_available";
  if (!file.manifest) {
    return warn(id, `could not confirm that the encrypted file is published yet (${file.check.detail})`);
  }
  const m = file.manifest.media;
  const want = ASPECT_SIZE[quote.spec.aspect];
  if (!want || want[0] !== m.width || want[1] !== m.height) {
    return fail(id, `the committed file is ${m.width}x${m.height}, not the ${quote.spec.aspect} size in the brief`);
  }
  if (Math.abs(m.durationMs - quote.spec.durationS * 1000) > 1_500) {
    return warn(
      id,
      `the committed file runs ${(m.durationMs / 1000).toFixed(1)} s; the brief says ${quote.spec.durationS} s`,
    );
  }
  return pass(
    id,
    `the encrypted file you are paying for is already published (${m.width}x${m.height}, ${(m.durationMs / 1000).toFixed(1)} s, ${file.manifest.chunks} chunk(s))`,
  );
}

const FORMAT_TITLES: Record<string, string> = {
  launch_sting: "Launch Sting",
  countdown: "Countdown",
  portfolio_pulse: "Portfolio Pulse",
  kinetic_post: "Kinetic Post",
  chart_moment: "Chart Moment",
  studio_sting: "Studio Sting",
  studio_spot: "Studio Spot",
  catalog: "Catalog piece",
};

export const formatTitle = (f: string): string => FORMAT_TITLES[f] ?? "Custom piece";

export function etaText(etaS: number): string {
  return approxDuration(etaS);
}
