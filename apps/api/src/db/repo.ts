import type { SqlDb, SqlStatement, SqlValue } from "../platform.js";
import type { JobKind, JobRow, OrderRow, PaymentRow, PendingKind, QuoteRow } from "./rows.js";

// Typed queries over D1. Every state transition is a conditional UPDATE whose `changes` count is the
// compare-and-set result, so concurrent requests (and the keeper) can race safely.

type Patch<T> = Partial<{ [K in keyof T]: T[K] }>;

export type NewJob = Pick<JobRow, "id" | "kind" | "order_id" | "max_attempts">;

const ORDER_MUTABLE = new Set<keyof OrderRow>([
  "status",
  "funding",
  "funding_tx",
  "registered",
  "manifest_hash",
  "delivered_at",
  "deliver_tx",
  "accepted",
  "decision_tx",
  "change_requested_at",
  "release_tx",
  "refund_tx",
  "cancel_tx",
  "to_seller",
  "to_buyer",
  "pending_kind",
  "pending_tx",
  "pending_since",
  "last_error",
  "revision_manifest_hash",
  "revision_preview_url",
  "revision_delivered_at",
  "buyer_accepted_at",
]);

const QUOTE_COLUMNS: (keyof QuoteRow)[] = [
  "id",
  "status",
  "tier",
  "format",
  "catalog_id",
  "buyer",
  "buyer_lc",
  "amount",
  "delivery",
  "hero_ms",
  "spec_json",
  "spec_hash",
  "terms_json",
  "terms_hash",
  "escrow",
  "data_snapshot",
  "still_url",
  "still_sha256",
  "preview_url",
  "manifest_hash",
  "eta_s",
  "quote_expires_at",
  "deadline",
  "pay_from",
  "pay_nonce",
  "order_id",
  "cancel_reason",
  "created_at",
  "finalized_at",
  "updated_at",
  "client_key",
];

const ORDER_COLUMNS: (keyof OrderRow)[] = [
  "id",
  "quote_id",
  "tier",
  "buyer_lc",
  "terms_hash",
  "escrow",
  "amount",
  "deadline",
  "status",
  "funding",
  "funding_tx",
  "funding_rail",
  "registered",
  "manifest_hash",
  "delivered_at",
  "deliver_tx",
  "accepted",
  "decision_tx",
  "change_requested_at",
  "release_tx",
  "refund_tx",
  "cancel_tx",
  "to_seller",
  "to_buyer",
  "pending_kind",
  "pending_tx",
  "pending_since",
  "last_error",
  "created_at",
  "updated_at",
];

function insertSql(table: string, cols: readonly string[]): string {
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
}

const v = (x: unknown): SqlValue => (x === undefined ? null : (x as SqlValue));

export interface SanctionsListRow {
  id: number;
  fetched_at: number;
  source: string;
  sha256: string;
  count: number;
  addresses: string;
}

/** What recordSettlement stores in the payment row (the replay store). */
export interface SettledPayment {
  fromLc: string;
  nonce: string;
  rail: string;
  txHash: string;
  status: number;
  headers: string;
  body: string;
}

export interface ChainTxRow {
  hash: string;
  kind: string;
  ref: string;
  nonce: number;
  status: "sent" | "confirmed" | "reverted" | "dropped";
  error: string | null;
  created_at: number;
  updated_at: number;
}

export class Repo {
  readonly db: SqlDb;
  constructor(db: SqlDb) {
    this.db = db;
  }

  // ---------------------------------------------------------------- quotes

  /** Quote and (Instant) its render job, atomically. */
  async createQuote(q: QuoteRow, job: NewJob | null): Promise<void> {
    const stmts = [this.db.prepare(insertSql("quotes", QUOTE_COLUMNS)).bind(...QUOTE_COLUMNS.map((k) => v(q[k])))];
    if (job) stmts.push(this.jobInsert({ ...job, quote_id: q.id, owner: q.client_key ?? q.buyer_lc }, q.created_at));
    await this.db.batch(stmts);
  }

  getQuote(id: string): Promise<QuoteRow | null> {
    return this.db.prepare("SELECT * FROM quotes WHERE id = ?").bind(id).first<QuoteRow>();
  }

  getQuoteByEscrow(escrow: string): Promise<QuoteRow | null> {
    return this.db.prepare("SELECT * FROM quotes WHERE escrow = ?").bind(escrow).first<QuoteRow>();
  }

  async countQuotesByBuyerSince(buyerLc: string, sinceS: number): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM quotes WHERE buyer_lc = ? AND created_at >= ?")
      .bind(buyerLc, sinceS)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async setQuoteStill(id: string, url: string, sha256: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE quotes SET still_url = ?, still_sha256 = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
      .bind(url, sha256, now, id)
      .run();
    return r.meta.changes === 1;
  }

  async setQuotePreview(id: string, url: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE quotes SET preview_url = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
      .bind(url, now, id)
      .run();
    return r.meta.changes === 1;
  }

  /** Studio previews arrive after payment (each delivery attempt has its own immutable URL). */
  async setStudioPreview(id: string, url: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE quotes SET preview_url = ?, updated_at = ? WHERE id = ? AND tier = 'studio' AND status = 'paid'")
      .bind(url, now, id)
      .run();
    return r.meta.changes === 1;
  }

  /** draft → final with the sealed spec/terms. */
  async finalizeQuote(
    id: string,
    f: Pick<
      QuoteRow,
      | "spec_json"
      | "spec_hash"
      | "terms_json"
      | "terms_hash"
      | "escrow"
      | "manifest_hash"
      | "eta_s"
      | "quote_expires_at"
      | "deadline"
    >,
    now: number,
  ): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE quotes SET status = 'final', spec_json = ?, spec_hash = ?, terms_json = ?, terms_hash = ?, escrow = ?,
           manifest_hash = ?, eta_s = ?, quote_expires_at = ?, deadline = ?, finalized_at = ?, updated_at = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .bind(
        f.spec_json,
        f.spec_hash,
        f.terms_json,
        f.terms_hash,
        f.escrow,
        f.manifest_hash,
        f.eta_s,
        f.quote_expires_at,
        f.deadline,
        now,
        now,
        id,
      )
      .run();
    return r.meta.changes === 1;
  }

  /** final → settling for exactly one authorization (the exactly-once gate). */
  async claimQuoteForSettlement(id: string, fromLc: string, nonce: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE quotes SET status = 'settling', pay_from = ?, pay_nonce = ?, updated_at = ?
         WHERE id = ? AND status = 'final' AND quote_expires_at > ?`,
      )
      .bind(fromLc, nonce, now, id, now)
      .run();
    return r.meta.changes === 1;
  }

  async releaseQuoteClaim(id: string, fromLc: string, nonce: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE quotes SET status = 'final', pay_from = NULL, pay_nonce = NULL, updated_at = ?
         WHERE id = ? AND status = 'settling' AND pay_from = ? AND pay_nonce = ?`,
      )
      .bind(now, id, fromLc, nonce)
      .run();
    return r.meta.changes === 1;
  }

  async markQuotePaid(id: string, orderId: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE quotes SET status = 'paid', order_id = ?, updated_at = ? WHERE id = ? AND status = 'settling'")
      .bind(orderId, now, id)
      .run();
    return r.meta.changes === 1;
  }

  async cancelQuote(id: string, reason: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE quotes SET status = 'cancelled', cancel_reason = ?, updated_at = ?
         WHERE id = ? AND status IN ('draft', 'final')`,
      )
      .bind(reason, now, id)
      .run();
    return r.meta.changes === 1;
  }

  /** Final quotes past their payment window → expired; drafts past theirs → cancelled. Returns rows changed. */
  async expireQuotes(now: number): Promise<number> {
    const [a, b] = await this.db.batch([
      this.db
        .prepare(
          "UPDATE quotes SET status = 'expired', updated_at = ? WHERE status = 'final' AND quote_expires_at <= ?",
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE quotes SET status = 'cancelled', cancel_reason = 'render_timeout', updated_at = ?
           WHERE status = 'draft' AND quote_expires_at <= ?`,
        )
        .bind(now, now),
    ]);
    return (a?.meta.changes ?? 0) + (b?.meta.changes ?? 0);
  }

  /**
   * Escrows the direct-rail scan watches: live final quotes first, then quotes that can no longer be paid whose
   * deadline is at most an hour old (late or mistaken transfers to return).
   */
  async directCandidates(now: number, limit: number): Promise<QuoteRow[]> {
    const r = await this.db
      .prepare(
        `SELECT * FROM quotes
         WHERE (status = 'final' AND quote_expires_at > ?)
            OR (status IN ('final', 'expired', 'cancelled') AND deadline > ?)
         ORDER BY quote_expires_at DESC, id LIMIT ?`,
      )
      .bind(now, now - 3600, limit)
      .all<QuoteRow>();
    return r.results;
  }

  /**
   * The order row, inserted only while the quote is still `settling` under exactly this claim. Re-running it (an
   * ambiguous D1 error, the keeper adopting an orphan while the request path records it) inserts nothing.
   */
  private conditionalOrderInsert(order: OrderRow, claimFrom: string, claimNonce: string): SqlStatement {
    const cols = ORDER_COLUMNS.join(", ");
    const marks = ORDER_COLUMNS.map(() => "?").join(", ");
    return this.db
      .prepare(
        `INSERT INTO orders (${cols}) SELECT ${marks}
         WHERE EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status = 'settling' AND pay_from = ? AND pay_nonce = ?)
           AND NOT EXISTS (SELECT 1 FROM orders WHERE quote_id = ?)`,
      )
      .bind(...ORDER_COLUMNS.map((k) => v(order[k])), order.quote_id, claimFrom, claimNonce, order.quote_id);
  }

  private quotePaid(order: OrderRow, claimFrom: string, claimNonce: string, now: number): SqlStatement {
    return this.db
      .prepare(
        `UPDATE quotes SET status = 'paid', order_id = ?, updated_at = ?
         WHERE id = ? AND status = 'settling' AND pay_from = ? AND pay_nonce = ?
           AND EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
      )
      .bind(order.id, now, order.quote_id, claimFrom, claimNonce, order.id);
  }

  /** Direct-rail order: order row and quote → paid, atomically. False if the claim was no longer ours. */
  async recordDirectOrder(order: OrderRow, now: number): Promise<boolean> {
    const claimNonce = order.escrow.toLowerCase();
    const [ins] = await this.db.batch([
      this.conditionalOrderInsert(order, "direct", claimNonce),
      this.quotePaid(order, "direct", claimNonce, now),
    ]);
    return (ins?.meta.changes ?? 0) === 1;
  }

  /** Moves a settling quote to the back of the reconciliation queue (it stays `settling`). */
  async touchSettling(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE quotes SET updated_at = ? WHERE id = ? AND status = 'settling'").bind(now, id).run();
  }

  /** Take the quote's single late-fund action slot (or one abandoned before `staleBefore`). */
  async claimLateAction(id: string, now: number, staleBefore: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE quotes SET late_action_at = ? WHERE id = ? AND (late_action_at IS NULL OR late_action_at < ?)")
      .bind(now, id, staleBefore)
      .run();
    return r.meta.changes === 1;
  }

  async releaseLateAction(id: string, at: number): Promise<void> {
    await this.db
      .prepare("UPDATE quotes SET late_action_at = NULL WHERE id = ? AND late_action_at = ?")
      .bind(id, at)
      .run();
  }

  /** Quotes stuck in `settling` (the worker died mid-settlement), for the keeper to reconcile. */
  async staleSettlingQuotes(before: number, limit: number): Promise<QuoteRow[]> {
    const r = await this.db
      .prepare("SELECT * FROM quotes WHERE status = 'settling' AND updated_at < ? ORDER BY updated_at LIMIT ?")
      .bind(before, limit)
      .all<QuoteRow>();
    return r.results;
  }

  /** Render jobs whose quote can no longer be paid are abandoned. */
  async failJobsOfClosedQuotes(now: number): Promise<number> {
    const r = await this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error = 'quote_closed', lease_expires_at = NULL, updated_at = ?
         WHERE kind = 'instant_render' AND status IN ('queued', 'claimed')
           AND quote_id IN (SELECT id FROM quotes WHERE status IN ('cancelled', 'expired'))`,
      )
      .bind(now)
      .run();
    return r.meta.changes;
  }

  // ---------------------------------------------------------------- payments

  getPayment(fromLc: string, nonce: string): Promise<PaymentRow | null> {
    return this.db
      .prepare("SELECT * FROM payments WHERE from_lc = ? AND nonce = ?")
      .bind(fromLc, nonce)
      .first<PaymentRow>();
  }

  /**
   * Claim (from, nonce) for settlement: new row, or a previously failed attempt. False ⇒ someone else holds it.
   * `bind` ties the eventual replay to the exact payment header and fixes the order id before money moves.
   */
  async claimPayment(
    fromLc: string,
    nonce: string,
    quoteId: string,
    wire: "v1" | "v2",
    now: number,
    bind: { sigSha256: string; validBefore: number; orderId: string },
  ) {
    const r = await this.db
      .prepare(
        `INSERT INTO payments (from_lc, nonce, quote_id, status, wire, created_at, updated_at, sig_sha256, valid_before, order_id)
         VALUES (?, ?, ?, 'settling', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (from_lc, nonce) DO UPDATE SET status = 'settling', quote_id = excluded.quote_id,
           wire = excluded.wire, error = NULL, updated_at = excluded.updated_at, sig_sha256 = excluded.sig_sha256,
           valid_before = excluded.valid_before, order_id = excluded.order_id
         WHERE payments.status = 'failed'`,
      )
      .bind(fromLc, nonce, quoteId, wire, now, now, bind.sigSha256, bind.validBefore, bind.orderId)
      .run();
    return r.meta.changes === 1;
  }

  async settlePayment(
    fromLc: string,
    nonce: string,
    p: { rail: string; txHash: string; status: number; headers: string; body: string },
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE payments SET status = 'settled', rail = ?, tx_hash = ?, response_status = ?, response_headers = ?,
           response_body = ?, updated_at = ? WHERE from_lc = ? AND nonce = ?`,
      )
      .bind(p.rail, p.txHash, p.status, p.headers, p.body, now, fromLc, nonce)
      .run();
  }

  async failPayment(fromLc: string, nonce: string, error: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE payments SET status = 'failed', error = ?, updated_at = ? WHERE from_lc = ? AND nonce = ? AND status = 'settling'",
      )
      .bind(error.slice(0, 500), now, fromLc, nonce)
      .run();
  }

  // ---------------------------------------------------------------- orders

  async insertOrder(o: OrderRow): Promise<void> {
    await this.db
      .prepare(insertSql("orders", ORDER_COLUMNS))
      .bind(...ORDER_COLUMNS.map((k) => v(o[k])))
      .run();
  }

  /**
   * Settlement bookkeeping in one transaction: order row, payment → settled (replay store), quote → paid. Each
   * statement is conditional on the quote still being `settling` under this (from, nonce) claim, so the request
   * path and the keeper's orphan adoption can both run it and exactly one order results. True ⇔ this call
   * inserted the order.
   */
  async recordSettlement(order: OrderRow, payment: SettledPayment, now: number): Promise<boolean> {
    const [ins] = await this.db.batch([
      this.conditionalOrderInsert(order, payment.fromLc, payment.nonce),
      this.db
        .prepare(
          `UPDATE payments SET status = 'settled', rail = ?, tx_hash = ?, response_status = ?, response_headers = ?,
             response_body = ?, order_id = ?, settled_at = ?, updated_at = ?
           WHERE from_lc = ? AND nonce = ? AND status = 'settling' AND EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
        )
        .bind(
          payment.rail,
          payment.txHash,
          payment.status,
          payment.headers,
          payment.body,
          order.id,
          now,
          now,
          payment.fromLc,
          payment.nonce,
          order.id,
        ),
      this.quotePaid(order, payment.fromLc, payment.nonce, now),
    ]);
    return (ins?.meta.changes ?? 0) === 1;
  }

  getOrder(id: string): Promise<OrderRow | null> {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<OrderRow>();
  }

  getOrderByQuote(quoteId: string): Promise<OrderRow | null> {
    return this.db.prepare("SELECT * FROM orders WHERE quote_id = ?").bind(quoteId).first<OrderRow>();
  }

  async listOrdersByBuyer(buyerLc: string, limit: number): Promise<OrderRow[]> {
    const r = await this.db
      .prepare("SELECT * FROM orders WHERE buyer_lc = ? ORDER BY created_at DESC, id LIMIT ?")
      .bind(buyerLc, limit)
      .all<OrderRow>();
    return r.results;
  }

  /** Studio inbox: paid orders awaiting delivery or in review. */
  async studioOrders(limit: number): Promise<OrderRow[]> {
    const r = await this.db
      .prepare(
        "SELECT * FROM orders WHERE tier = 'studio' AND status IN ('funding', 'sealed', 'delivered') ORDER BY deadline LIMIT ?",
      )
      .bind(limit)
      .all<OrderRow>();
    return r.results;
  }

  /** Orders whose funds are (or may be) in escrow and still need the API to act. */
  async ordersNeedingWork(now: number, limit: number): Promise<OrderRow[]> {
    const r = await this.db
      .prepare(
        `SELECT * FROM orders
         WHERE status IN ('funding', 'sealed', 'delivered')
            OR (status = 'failed' AND deadline < ? AND deadline > ?)
         ORDER BY updated_at ASC, id LIMIT ?`,
      )
      .bind(now, now - 7 * 86_400, limit)
      .all<OrderRow>();
    return r.results;
  }

  async capacityCounts(): Promise<{ instantInflight: number; studioOpen: number }> {
    const r = await this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN tier = 'instant' AND status IN ('funding', 'sealed') THEN 1 ELSE 0 END) AS instant_inflight,
           SUM(CASE WHEN tier = 'studio' AND status IN ('funding', 'sealed', 'delivered') THEN 1 ELSE 0 END) AS studio_open
         FROM orders WHERE status IN ('funding', 'sealed', 'delivered')`,
      )
      .first<{ instant_inflight: number | null; studio_open: number | null }>();
    return { instantInflight: r?.instant_inflight ?? 0, studioOpen: r?.studio_open ?? 0 };
  }

  async updateOrder(id: string, patch: Patch<OrderRow>, now: number): Promise<void> {
    const keys = (Object.keys(patch) as (keyof OrderRow)[]).filter((k) => ORDER_MUTABLE.has(k));
    if (keys.length === 0) return;
    await this.db
      .prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => v(patch[k])), now, id)
      .run();
  }

  /** Take the order's single in-flight chain-action slot (or a slot abandoned before `staleBefore`). */
  async claimPending(id: string, kind: PendingKind, now: number, staleBefore: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE orders SET pending_kind = ?, pending_since = ?, pending_tx = NULL, updated_at = ?
         WHERE id = ? AND (pending_kind IS NULL OR pending_since < ?)`,
      )
      .bind(kind, now, now, id, staleBefore)
      .run();
    return r.meta.changes === 1;
  }

  async setPendingTx(id: string, kind: PendingKind, tx: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE orders SET pending_tx = ?, updated_at = ? WHERE id = ? AND pending_kind = ?")
      .bind(tx, now, id, kind)
      .run();
  }

  /** Release the slot and apply `patch` (only if the slot is still ours). */
  async finishPending(id: string, kind: PendingKind, patch: Patch<OrderRow>, now: number): Promise<void> {
    const keys = (Object.keys(patch) as (keyof OrderRow)[]).filter(
      (k) => ORDER_MUTABLE.has(k) && !k.startsWith("pending_"),
    );
    const sets = [...keys.map((k) => `${k} = ?`), "pending_kind = NULL", "pending_tx = NULL", "pending_since = NULL"];
    await this.db
      .prepare(`UPDATE orders SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND pending_kind = ?`)
      .bind(...keys.map((k) => v(patch[k])), now, id, kind)
      .run();
  }

  // ---------------------------------------------------------------- jobs

  private jobInsert(j: NewJob & { quote_id: string; owner?: string | null }, now: number): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO jobs (id, kind, quote_id, order_id, status, attempts, max_attempts, created_at, updated_at, owner)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
      )
      .bind(j.id, j.kind, j.quote_id, j.order_id, j.max_attempts, now, now, j.owner ?? null);
  }

  async insertJob(j: NewJob & { quote_id: string }, now: number): Promise<void> {
    await this.jobInsert(j, now).run();
  }

  getJob(id: string): Promise<JobRow | null> {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  }

  async activeJobForQuote(quoteId: string): Promise<JobRow | null> {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE quote_id = ? AND status IN ('queued', 'claimed') ORDER BY created_at DESC LIMIT 1",
      )
      .bind(quoteId)
      .first<JobRow>();
  }

  /**
   * Claim the next queued job, round-robin across owners (client bucket): a job's rank is the number of jobs of
   * the same owner rendering or queued ahead of it, so one client's backlog cannot push everyone else back.
   * Insertion order (rowid) breaks ties.
   */
  async claimJob(workerId: string, kinds: readonly JobKind[], now: number, leaseS: number): Promise<JobRow | null> {
    const marks = kinds.map(() => "?").join(", ");
    for (let tries = 0; tries < 3; tries++) {
      const r = await this.db
        .prepare(
          `UPDATE jobs SET status = 'claimed', worker_id = ?, attempts = attempts + 1, lease_expires_at = ?,
             progress = 0, error = NULL, updated_at = ?
           WHERE id = (
               SELECT j.id FROM jobs j WHERE j.status = 'queued' AND j.kind IN (${marks})
               ORDER BY (
                 SELECT COUNT(*) FROM jobs k
                 WHERE k.owner = j.owner AND k.kind = j.kind
                   AND (k.status = 'claimed' OR (k.status = 'queued' AND k.rowid < j.rowid))
               ), j.rowid
               LIMIT 1)
             AND status = 'queued'
           RETURNING *`,
        )
        .bind(workerId, now + leaseS, now, ...kinds)
        .all<JobRow>();
      if (r.results[0]) return r.results[0];
      const any = await this.db
        .prepare(`SELECT 1 AS x FROM jobs WHERE status = 'queued' AND kind IN (${marks}) LIMIT 1`)
        .bind(...kinds)
        .first();
      if (!any) return null;
    }
    return null;
  }

  /** Claim a specific job: queued, or claimed with an expired lease. */
  async claimJobById(id: string, workerId: string, now: number, leaseS: number): Promise<JobRow | null> {
    const r = await this.db
      .prepare(
        `UPDATE jobs SET status = 'claimed', worker_id = ?, attempts = attempts + 1, lease_expires_at = ?,
           progress = 0, error = NULL, updated_at = ?
         WHERE id = ? AND (status = 'queued' OR (status = 'claimed' AND lease_expires_at < ?))
         RETURNING *`,
      )
      .bind(workerId, now + leaseS, now, id, now)
      .all<JobRow>();
    return r.results[0] ?? null;
  }

  async heartbeatJob(id: string, workerId: string, progress: number | null, now: number, leaseS: number) {
    const r = await this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?, progress = COALESCE(?, progress), updated_at = ?
         WHERE id = ? AND status = 'claimed' AND worker_id = ?`,
      )
      .bind(now + leaseS, progress, now, id, workerId)
      .run();
    return r.meta.changes === 1;
  }

  async setJobArtifact(
    id: string,
    kind: "still" | "preview",
    key: string,
    sha256: string,
    now: number,
  ): Promise<boolean> {
    const col = kind === "still" ? "still" : "preview";
    const r = await this.db
      .prepare(`UPDATE jobs SET ${col}_key = ?, ${col}_sha256 = ?, updated_at = ? WHERE id = ? AND status = 'claimed'`)
      .bind(key, sha256, now, id)
      .run();
    return r.meta.changes === 1;
  }

  /** The manifest is write-once per job attempt: a different manifest would invalidate uploaded chunks. */
  async setJobManifest(id: string, manifestJson: string, manifestHash: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE jobs SET manifest_json = ?, manifest_hash = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND (manifest_hash IS NULL OR manifest_hash = ?)`,
      )
      .bind(manifestJson, manifestHash, now, id, manifestHash)
      .run();
    return r.meta.changes === 1;
  }

  async putChunk(jobId: string, idx: number, sha256: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO job_chunks (job_id, idx, sha256, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (job_id, idx) DO UPDATE SET sha256 = excluded.sha256`,
      )
      .bind(jobId, idx, sha256, now)
      .run();
  }

  async chunkHashes(jobId: string): Promise<Map<number, string>> {
    const r = await this.db
      .prepare("SELECT idx, sha256 FROM job_chunks WHERE job_id = ?")
      .bind(jobId)
      .all<{ idx: number; sha256: string }>();
    return new Map(r.results.map((x) => [x.idx, x.sha256]));
  }

  async completeJob(id: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        "UPDATE jobs SET status = 'done', progress = 100, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'",
      )
      .bind(now, id)
      .run();
    return r.meta.changes === 1;
  }

  /** Retryable failures re-queue (fresh artifacts) until max_attempts; returns the resulting status. */
  async failJob(id: string, error: string, retryable: boolean, now: number): Promise<JobRow["status"] | null> {
    const r = await this.db
      .prepare(
        `UPDATE jobs SET
           status = CASE WHEN ? = 1 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
           error = ?, worker_id = NULL, lease_expires_at = NULL, still_key = NULL, still_sha256 = NULL,
           preview_key = NULL, preview_sha256 = NULL, manifest_json = NULL, manifest_hash = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed'
         RETURNING status`,
      )
      .bind(retryable ? 1 : 0, error.slice(0, 500), now, id)
      .all<{ status: JobRow["status"] }>();
    if (r.results[0]) await this.db.prepare("DELETE FROM job_chunks WHERE job_id = ?").bind(id).run();
    return r.results[0]?.status ?? null;
  }

  async expiredLeases(now: number, limit: number): Promise<JobRow[]> {
    const r = await this.db
      .prepare("SELECT * FROM jobs WHERE status = 'claimed' AND lease_expires_at <= ? LIMIT ?")
      .bind(now, limit)
      .all<JobRow>();
    return r.results;
  }

  async failJobsForQuote(quoteId: string, error: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE quote_id = ? AND status IN ('queued', 'claimed')",
      )
      .bind(error, now, quoteId)
      .run();
  }

  // ---------------------------------------------------------------- workers

  /**
   * Records a render worker's last-seen time, rewriting an existing row only once it is `minIntervalS` old: an idle
   * worker polls every ~2 s, and D1 bills (and on the free plan caps) row writes, not the no-op conditional update.
   * Returns whether a row was written.
   */
  async touchWorker(workerId: string, now: number, minIntervalS = 0): Promise<boolean> {
    const r = await this.db
      .prepare(
        `INSERT INTO worker_heartbeats (worker_id, seen_at) VALUES (?, ?)
         ON CONFLICT (worker_id) DO UPDATE SET seen_at = excluded.seen_at
         WHERE worker_heartbeats.seen_at <= excluded.seen_at - ?`,
      )
      .bind(workerId, now, minIntervalS)
      .run();
    return r.meta.changes === 1;
  }

  async lastWorkerSeen(): Promise<number | null> {
    const r = await this.db.prepare("SELECT MAX(seen_at) AS t FROM worker_heartbeats").first<{ t: number | null }>();
    return r?.t ?? null;
  }

  /** Queued + rendering Instant jobs: overall, and for one fairness bucket. */
  async renderQueue(owner: string): Promise<{ total: number; owner: number }> {
    const r = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN owner = ? THEN 1 ELSE 0 END), 0) AS mine
         FROM jobs WHERE kind = 'instant_render' AND status IN ('queued', 'claimed')`,
      )
      .bind(owner)
      .first<{ total: number; mine: number }>();
    return { total: r?.total ?? 0, owner: r?.mine ?? 0 };
  }

  async queueDepth(): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'claimed')")
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  // ---------------------------------------------------------------- sanctions

  latestSanctionsList(): Promise<SanctionsListRow | null> {
    return this.db
      .prepare("SELECT * FROM sanctions_lists ORDER BY fetched_at DESC, id DESC LIMIT 1")
      .first<SanctionsListRow>();
  }

  async insertSanctionsList(l: Omit<SanctionsListRow, "id">): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT INTO sanctions_lists (fetched_at, source, sha256, count, addresses) VALUES (?, ?, ?, ?, ?)")
        .bind(l.fetched_at, l.source, l.sha256, l.count, l.addresses),
      this.db
        .prepare(
          "DELETE FROM sanctions_lists WHERE id NOT IN (SELECT id FROM sanctions_lists ORDER BY fetched_at DESC, id DESC LIMIT 3)",
        )
        .bind(),
    ]);
  }

  // ---------------------------------------------------------------- SIWE

  async insertSiweNonce(nonce: string, addressLc: string, message: string, expiresAt: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO siwe_nonces (nonce, address_lc, message, expires_at) VALUES (?, ?, ?, ?)")
      .bind(nonce, addressLc, message, expiresAt)
      .run();
  }

  /** Single-use: true only for the first caller presenting an unexpired nonce issued to that address. */
  async consumeSiweNonce(nonce: string, addressLc: string, message: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE siwe_nonces SET used = 1
         WHERE nonce = ? AND address_lc = ? AND message = ? AND used = 0 AND expires_at > ?`,
      )
      .bind(nonce, addressLc, message, now)
      .run();
    return r.meta.changes === 1;
  }

  async pruneSiweNonces(now: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM siwe_nonces WHERE expires_at < ?")
      .bind(now - 86_400)
      .run();
  }

  // ---------------------------------------------------------------- chain journal

  async journalTx(t: Omit<ChainTxRow, "error" | "updated_at"> & { error?: string | null }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO chain_txs (hash, kind, ref, nonce, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hash) DO UPDATE SET status = excluded.status, error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .bind(t.hash, t.kind, t.ref, t.nonce, t.status, t.error ?? null, t.created_at, t.created_at)
      .run();
  }

  async setTxStatus(hash: string, status: ChainTxRow["status"], error: string | null, now: number) {
    await this.db
      .prepare("UPDATE chain_txs SET status = ?, error = ?, updated_at = ? WHERE hash = ?")
      .bind(status, error, now, hash)
      .run();
  }

  async sentTxsOlderThan(before: number, limit: number): Promise<ChainTxRow[]> {
    const r = await this.db
      .prepare("SELECT * FROM chain_txs WHERE status = 'sent' AND created_at <= ? ORDER BY created_at LIMIT ?")
      .bind(before, limit)
      .all<ChainTxRow>();
    return r.results;
  }

  // ---------------------------------------------------------------- rate limits

  /**
   * Token bucket in one statement: refill by elapsed time (capped at `capacity`), then take one token if at least
   * one is available. True ⇔ the request may proceed.
   */
  async takeToken(key: string, capacity: number, refillPerS: number, nowMs: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `INSERT INTO rate_buckets (key, tokens, updated_ms) VALUES (?, ? - 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           tokens = MIN(?, tokens + MAX(0, excluded.updated_ms - updated_ms) / 1000.0 * ?) - 1,
           updated_ms = MAX(updated_ms, excluded.updated_ms)
         WHERE MIN(?, tokens + MAX(0, excluded.updated_ms - updated_ms) / 1000.0 * ?) >= 1
         RETURNING tokens`,
      )
      .bind(key, capacity, nowMs, capacity, refillPerS, capacity, refillPerS)
      .all<{ tokens: number }>();
    return r.results.length === 1;
  }

  async pruneRateBuckets(beforeMs: number): Promise<void> {
    await this.db.prepare("DELETE FROM rate_buckets WHERE updated_ms < ?").bind(beforeMs).run();
  }

  // ---------------------------------------------------------------- locks

  /** Take (or renew our own) lease on `name` until `now + ttlS`; false while someone else holds it. */
  async acquireLock(name: string, holder: string, now: number, ttlS: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `INSERT INTO locks (name, holder, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE locks.expires_at <= ? OR locks.holder = excluded.holder`,
      )
      .bind(name, holder, now + ttlS, now)
      .run();
    return r.meta.changes === 1;
  }

  async releaseLock(name: string, holder: string): Promise<void> {
    await this.db.prepare("DELETE FROM locks WHERE name = ? AND holder = ?").bind(name, holder).run();
  }

  // ---------------------------------------------------------------- stats

  async stats(): Promise<Record<string, number | string>> {
    // Amounts are ≤ 50 USDC (5e7 atomic), so SQLite integer sums are exact far beyond any realistic volume.
    const o = await this.db
      .prepare(
        `SELECT COUNT(*) AS orders,
           COALESCE(SUM(status = 'key_published'), 0) AS delivered,
           COALESCE(SUM(status IN ('returned', 'void')), 0) AS returned,
           COALESCE(SUM(status IN ('funding', 'sealed', 'delivered')), 0) AS open,
           COALESCE(SUM(CASE WHEN status != 'failed' THEN CAST(amount AS INTEGER) END), 0) AS escrowed,
           COALESCE(SUM(CAST(to_seller AS INTEGER)), 0) AS paid_out
         FROM orders`,
      )
      .first<Record<string, number>>();
    const q = await this.db.prepare("SELECT COUNT(*) AS n FROM quotes").first<{ n: number }>();
    return {
      quotes: q?.n ?? 0,
      orders: o?.orders ?? 0,
      delivered: o?.delivered ?? 0,
      returned: o?.returned ?? 0,
      open: o?.open ?? 0,
      escrowed_atomic: String(o?.escrowed ?? 0),
      paid_to_studio_atomic: String(o?.paid_out ?? 0),
    };
  }
}
