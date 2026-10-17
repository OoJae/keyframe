-- Security hardening (ADR-019): replay binding, settlement adoption, Studio revision, late-fund slot, throttling.
-- Additive only: every new column is nullable, so rows written by v1 keep working.

-- Paid-response replay is bound to the exact payment header (sha256 of PAYMENT-SIGNATURE / X-PAYMENT as received)
-- and served in full only for a short window after settlement. order_id is chosen before settlement so a payment
-- whose bookkeeping is adopted later by the keeper keeps the access_token the client may already hold.
ALTER TABLE payments ADD COLUMN sig_sha256 TEXT;
ALTER TABLE payments ADD COLUMN valid_before INTEGER;
ALTER TABLE payments ADD COLUMN order_id TEXT;
ALTER TABLE payments ADD COLUMN settled_at INTEGER;

-- Studio "changes": one off-chain revision (the contract knows one deliver), and an explicit buyer accept verified
-- off-chain after the on-chain review window (decideBySig is only valid inside it).
ALTER TABLE orders ADD COLUMN revision_manifest_hash TEXT;
ALTER TABLE orders ADD COLUMN revision_preview_url TEXT;
ALTER TABLE orders ADD COLUMN revision_delivered_at INTEGER;
ALTER TABLE orders ADD COLUMN buyer_accepted_at INTEGER;

-- One in-flight late-fund action (cancel/refund of funds that reached E of an unpayable quote) per quote, and the
-- client bucket (hashed IP) that created the quote, for fair render ordering and per-client queue caps.
ALTER TABLE quotes ADD COLUMN late_action_at INTEGER;
ALTER TABLE quotes ADD COLUMN client_key TEXT;

ALTER TABLE jobs ADD COLUMN owner TEXT;
CREATE INDEX jobs_owner ON jobs (owner, status);

-- Token buckets (per client and endpoint class). tokens is fractional; updated_ms is unix milliseconds.
CREATE TABLE rate_buckets (
  key        TEXT PRIMARY KEY,
  tokens     REAL NOT NULL,
  updated_ms INTEGER NOT NULL
);
