import { Status } from "@keyframe/protocol";
import type { Hex } from "viem";
import { scanDirectDeposits } from "./orders/direct.js";
import { advanceOrder, encodeFactoryCall } from "./orders/lifecycle.js";
import { nowS, type Services } from "./services.js";

// Cron keeper (every minute; architecture.md §c.6 keeper #1). Chain-facing work is idempotent and bounded per tick:
// confirm pending funding, register PayAI-funded escrows, release Instant orders, release Studio orders after
// acceptance or the review end, refund expired orders, open direct-rail deposits, and sweep the factory with
// refundExpired(20). A D1 lease keeps overlapping ticks from running concurrently; each phase fails on its own.

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
  txs_reconciled: number;
  direct_opened: number;
  direct_returned: number;
  refund_expired_sent: boolean;
  sanctions: "fresh" | "refreshed" | "refresh_failed";
  phases_failed: string[];
}

const SETTLING_STALE_S = 600;
const LOCK = "keeper";
const LOCK_TTL_S = 55;

const emptyReport = (): KeeperReport => ({
  skipped: false,
  quotes_closed: 0,
  jobs_requeued: 0,
  jobs_abandoned: 0,
  orders_advanced: 0,
  orders_failed: 0,
  settling_reconciled: 0,
  txs_reconciled: 0,
  direct_opened: 0,
  direct_returned: 0,
  refund_expired_sent: false,
  sanctions: "fresh",
  phases_failed: [],
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
    await runPhases(s, opts, report, started);
  } finally {
    await s.repo.releaseLock(LOCK, holder).catch(() => undefined);
  }
  s.log.info("keeper_tick", { ...report, ms: Date.now() - started });
  return report;
}

async function runPhases(s: Services, opts: KeeperOptions, report: KeeperReport, started: number) {
  const budget = opts.budgetMs ?? 45_000;
  const waitMs = opts.waitMs ?? 4_000;
  const now = nowS(s);
  const inBudget = () => Date.now() - started <= budget;
  const phase = async (name: string, fn: () => Promise<void>) => {
    if (!inBudget()) return;
    try {
      await fn();
    } catch (e) {
      report.phases_failed.push(name);
      s.log.warn("keeper_phase_failed", { phase: name, error: e instanceof Error ? e.message.slice(0, 160) : "error" });
    }
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

  // An isolate that died between claiming a quote and recording the order leaves it `settling`. If nothing reached
  // the escrow, reopen the quote; otherwise the funds are registered/refundable on-chain and an operator follows up.
  await phase("stale_settling", async () => {
    if (!s.chain) return;
    for (const q of await s.repo.staleSettlingQuotes(now - SETTLING_STALE_S, 10)) {
      if (!q.pay_from || !q.pay_nonce) continue;
      if (q.pay_from === "direct") {
        // direct-rail claim: the next scan re-opens it (register is idempotent via AlreadyRegistered)
        await s.repo.releaseQuoteClaim(q.id, q.pay_from, q.pay_nonce, now);
        report.settling_reconciled++;
        continue;
      }
      const view = await s.chain.orderOf(s.cfg.factory, q.terms_hash as Hex);
      const bal = await s.chain.balanceOf(s.cfg.usdc, q.escrow as Hex);
      if (view.status === Status.None && bal === 0n) {
        await s.repo.failPayment(q.pay_from, q.pay_nonce, "settlement_abandoned", now);
        await s.repo.releaseQuoteClaim(q.id, q.pay_from, q.pay_nonce, now);
        report.settling_reconciled++;
      } else {
        s.log.error("orphan_settlement", { quote_id: q.id, chain_status: view.status, escrow: q.escrow });
      }
    }
  });

  await phase("orders", async () => {
    for (const o of await s.repo.ordersNeedingWork(now, opts.maxOrders ?? 25)) {
      if (!inBudget()) break;
      try {
        await advanceOrder(s, o, waitMs);
        report.orders_advanced++;
      } catch (e) {
        report.orders_failed++;
        s.log.warn("keeper_order_failed", {
          order_id: o.id,
          error: e instanceof Error ? e.message.slice(0, 160) : "error",
        });
      }
    }
  });

  await phase("direct_rail", async () => {
    if (!s.chain) return;
    const direct = await scanDirectDeposits(s, waitMs);
    report.direct_opened = direct.opened;
    report.direct_returned = direct.returned;
  });

  await phase("refund_expired", async () => {
    if (!s.chain || (await s.chain.refundableCount(s.cfg.factory, 50)) === 0n) return;
    const r = await s.relayer.send({
      kind: "refund_expired",
      ref: "factory",
      data: encodeFactoryCall.refundExpired(20),
      waitMs: 0,
    });
    report.refund_expired_sent = r.state === "pending" || r.state === "confirmed";
  });

  // Journal entries still "sent" (refundExpired, or orders settled elsewhere): the relayer records the outcome or
  // re-broadcasts a transaction the node lost.
  await phase("journal", async () => {
    for (const tx of await s.repo.sentTxsOlderThan(now - 60, 10)) {
      if (!inBudget()) break;
      const r = await s.relayer.receipt(tx.hash as Hex, 0);
      if (r.state === "unknown") await s.repo.setTxStatus(tx.hash, "dropped", "unknown to relayer", now);
      else if (r.state !== "pending") report.txs_reconciled++;
    }
  });

  await phase("siwe_prune", () => s.repo.pruneSiweNonces(now));
}
