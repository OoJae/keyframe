import { scanDirectDeposits } from "./orders/direct.js";
import { advanceOrder, encodeFactoryCall } from "./orders/lifecycle.js";
import { reconcileSettlement } from "./orders/settle.js";
import { errorText } from "./redact.js";
import { nowS, type Services } from "./services.js";

// Cron keeper (every minute; architecture.md §c.6 keeper #1). Chain-facing work is idempotent and bounded per tick:
// adopt orphaned settlements, confirm pending funding, register PayAI-funded escrows, release Instant orders,
// release Studio orders after acceptance or the review end, refund expired orders (per order, from the DB), open
// direct-rail deposits, and sweep the factory with refundExpired only when an eth_call shows it would refund
// something. A D1 lease keeps overlapping ticks apart; every phase has its own time budget inside the lease, the
// lease is renewed between phases, and each phase fails on its own.

export interface KeeperOptions {
  waitMs?: number;
  maxOrders?: number;
  budgetMs?: number;
}

export interface KeeperReport {
  skipped: boolean;
  quotes_closed: number;
  jobs_requeued: number;
  jobs_abandoned: number;
  orders_advanced: number;
  orders_failed: number;
  settling_reconciled: number;
  settling_adopted: number;
  settling_waiting: number;
  txs_reconciled: number;
  direct_opened: number;
  direct_returned: number;
  refund_expired_sent: boolean;
  sanctions: "fresh" | "refreshed" | "refresh_failed";
  phases_failed: string[];
  phases_cut: string[];
}

export const SETTLING_STALE_S = 600;
const LOCK = "keeper";
const LOCK_TTL_S = 55;
/** refundableCount and refundExpired scan the same window, so a positive count is for entries the call reaches. */
export const REFUND_EXPIRED_SCAN = 20;

const emptyReport = (): KeeperReport => ({
  skipped: false,
  quotes_closed: 0,
  jobs_requeued: 0,
  jobs_abandoned: 0,
  orders_advanced: 0,
  orders_failed: 0,
  settling_reconciled: 0,
  settling_adopted: 0,
  settling_waiting: 0,
  txs_reconciled: 0,
  direct_opened: 0,
  direct_returned: 0,
  refund_expired_sent: false,
  sanctions: "fresh",
  phases_failed: [],
  phases_cut: [],
});

export async function keeperTick(s: Services, opts: KeeperOptions = {}): Promise<KeeperReport> {
  const report = emptyReport();
  const holder = crypto.randomUUID();
  if (!(await s.repo.acquireLock(LOCK, holder, nowS(s), LOCK_TTL_S))) {
    report.skipped = true;
    return report;
  }
  const started = Date.now();
  try {
    await runPhases(s, opts, report, started, holder);
  } finally {
    await s.repo.releaseLock(LOCK, holder).catch(() => undefined);
  }
  s.log.info("keeper_tick", { ...report, ms: Date.now() - started });
  return report;
}

/** Share of the tick budget each phase may use (the rest stays for the phases after it). */
const PHASE_SHARE: Record<string, number> = {
  sanctions: 0.15,
  quotes_and_jobs: 0.1,
  stale_settling: 0.2,
  orders: 0.4,
  direct_rail: 0.2,
  refund_expired: 0.1,
  journal: 0.1,
  prune: 0.05,
};

async function runPhases(s: Services, opts: KeeperOptions, report: KeeperReport, started: number, holder: string) {
  // The whole tick stays well inside the lease (LOCK_TTL_S), so a slow tick never overlaps the next one.
  const budget = Math.min(opts.budgetMs ?? 45_000, (LOCK_TTL_S - 10) * 1000);
  const waitMs = Math.min(opts.waitMs ?? 4_000, Math.floor(budget / 10));
  const now = nowS(s);
  const tickEnd = started + budget;
  let leaseOk = true;
  const phase = async (name: string, fn: (deadlineMs: number) => Promise<void>) => {
    if (!leaseOk || Date.now() >= tickEnd) {
      report.phases_cut.push(name);
      return;
    }
    const deadline = Math.min(tickEnd, Date.now() + budget * (PHASE_SHARE[name] ?? 0.1));
    try {
      await fn(deadline);
    } catch (e) {
      report.phases_failed.push(name);
      s.log.warn("keeper_phase_failed", { phase: name, error: errorText(e, 160) });
    }
    // Renew our lease; if someone else holds it now (we overran), stop.
    leaseOk = await s.repo.acquireLock(LOCK, holder, nowS(s), LOCK_TTL_S).catch(() => false);
  };

  await phase("sanctions", async () => {
    const st = await s.sanctions.status();
    if (st.fetched_at === null || now - st.fetched_at > s.cfg.ofacRefreshS) {
      report.sanctions = (await s.sanctions.refresh()).ok ? "refreshed" : "refresh_failed";
    }
  });

  await phase("quotes_and_jobs", async () => {
    report.quotes_closed = await s.repo.expireQuotes(now);
    for (const job of await s.repo.expiredLeases(now, 50)) {
      const status = await s.repo.failJob(job.id, "lease_expired", true, now);
      if (status === "queued") report.jobs_requeued++;
      if (status === "failed" && job.kind === "instant_render") {
        await s.repo.cancelQuote(job.quote_id, "render_failed", now);
      }
    }
    report.jobs_abandoned = await s.repo.failJobsOfClosedQuotes(now);
  });

  // An isolate that died (or a request whose bookkeeping failed) between claiming a quote and recording the order
  // leaves it `settling`. Money at E ⇒ adopt the order (same order id, so the client's access_token works);
  // nothing at E and the authorization unused ⇒ reopen; otherwise wait (and rotate to the back of the queue).
  await phase("stale_settling", async (deadline) => {
    if (!s.chain) return;
    for (const q of await s.repo.staleSettlingQuotes(now - SETTLING_STALE_S, 25)) {
      if (Date.now() > deadline) break;
      if (!q.pay_from || !q.pay_nonce) continue;
      if (q.pay_from === "direct") {
        // direct-rail claim: the next scan re-opens it (register is idempotent via AlreadyRegistered)
        await s.repo.releaseQuoteClaim(q.id, q.pay_from, q.pay_nonce, now);
        report.settling_reconciled++;
        continue;
      }
      let out: Awaited<ReturnType<typeof reconcileSettlement>> = "waiting";
      try {
        out = await reconcileSettlement(s, q, { reopen: true });
      } catch (e) {
        s.log.warn("orphan_reconcile_failed", { quote_id: q.id, error: errorText(e, 160) });
      }
      if (out === "adopted") report.settling_adopted++;
      else if (out === "reopened") report.settling_reconciled++;
      else {
        report.settling_waiting++;
        await s.repo.touchSettling(q.id, now);
      }
    }
  });

  await phase("orders", async (deadline) => {
    for (const o of await s.repo.ordersNeedingWork(now, opts.maxOrders ?? 25)) {
      if (Date.now() > deadline) break;
      try {
        await advanceOrder(s, o, waitMs);
        report.orders_advanced++;
      } catch (e) {
        report.orders_failed++;
        s.log.warn("keeper_order_failed", { order_id: o.id, error: errorText(e, 160) });
      }
    }
  });

  await phase("direct_rail", async (deadline) => {
    if (!s.chain) return;
    const direct = await scanDirectDeposits(s, waitMs, 20, deadline);
    report.direct_opened = direct.opened;
    report.direct_returned = direct.returned;
  });

  // Per-order refunds (orders phase) are the primary path. refundExpired is only for escrows the DB does not know
  // (third-party registrations), and only when a simulation shows the call would refund at least one entry, so an
  // entry it cannot clear never becomes a relayer transaction per tick.
  await phase("refund_expired", async () => {
    const chain = s.chain;
    const operator = s.cfg.operator;
    if (!chain || !operator) return;
    if ((await chain.refundableCount(s.cfg.factory, REFUND_EXPIRED_SCAN)) === 0n) return;
    const would = await chain.simulateRefundExpired(s.cfg.factory, REFUND_EXPIRED_SCAN, operator);
    if (would === 0n) {
      s.log.info("refund_expired_no_progress", { scan: REFUND_EXPIRED_SCAN });
      return;
    }
    const r = await s.relayer.send({
      kind: "refund_expired",
      ref: "factory",
      data: encodeFactoryCall.refundExpired(REFUND_EXPIRED_SCAN),
      waitMs: 0,
    });
    report.refund_expired_sent = r.state === "pending" || r.state === "confirmed";
  });

  // Journal entries still "sent" (refundExpired, or orders settled elsewhere): the relayer records the outcome or
  // re-broadcasts a transaction the node lost.
  await phase("journal", async (deadline) => {
    for (const tx of await s.repo.sentTxsOlderThan(now - 60, 10)) {
      if (Date.now() > deadline) break;
      const r = await s.relayer.receipt(tx.hash as `0x${string}`, 0);
      if (r.state === "unknown") await s.repo.setTxStatus(tx.hash, "dropped", "unknown to relayer", now);
      else if (r.state !== "pending") report.txs_reconciled++;
    }
  });

  await phase("prune", async () => {
    await s.repo.pruneSiweNonces(now);
    await s.repo.pruneRateBuckets(s.nowMs() - 86_400_000);
  });
}
