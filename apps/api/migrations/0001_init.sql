-- Keyframe API schema v1 (Cloudflare D1 / SQLite). Times are unix seconds. Addresses in *_lc columns are
-- lowercase; display copies keep EIP-55. Money is atomic USDC as decimal TEXT (never REAL).

-- Quotes. status: draft -> final -> settling -> paid; final -> expired; draft|final -> cancelled.
-- spec_json / terms_json are the current (draft: provisional) frozen objects; the final ones are immutable.
CREATE TABLE quotes (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('draft','final','settling','paid','expired','cancelled')),
  tier             TEXT NOT NULL CHECK (tier IN ('instant','studio')),
  format           TEXT NOT NULL,
  catalog_id       TEXT NOT NULL,
  buyer            TEXT NOT NULL,
  buyer_lc         TEXT NOT NULL,
  amount           TEXT NOT NULL,
  delivery         TEXT NOT NULL CHECK (delivery IN ('public','private')),
  hero_ms          INTEGER NOT NULL,
  spec_json        TEXT NOT NULL,
  spec_hash        TEXT NOT NULL,
  terms_json       TEXT NOT NULL,
  terms_hash       TEXT NOT NULL UNIQUE,
  escrow           TEXT NOT NULL UNIQUE,
  data_snapshot    TEXT,
  still_url        TEXT,
  still_sha256     TEXT,
  preview_url      TEXT,
  manifest_hash    TEXT,
  eta_s            INTEGER NOT NULL,
  quote_expires_at INTEGER NOT NULL,
  deadline         INTEGER NOT NULL,
  pay_from         TEXT,
  pay_nonce        TEXT,
  order_id         TEXT,
  cancel_reason    TEXT,
  created_at       INTEGER NOT NULL,
  finalized_at     INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX quotes_buyer ON quotes (buyer_lc, created_at);
CREATE INDEX quotes_status ON quotes (status, quote_expires_at);

-- One row per EIP-3009 authorization (from, nonce): the exactly-once key and the byte-exact replay store.
-- status: settling -> settled | failed.
CREATE TABLE payments (
  from_lc          TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  quote_id         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('settling','settled','failed')),
  wire             TEXT NOT NULL CHECK (wire IN ('v1','v2')),
  rail             TEXT,
  tx_hash          TEXT,
  response_status  INTEGER,
  response_headers TEXT,
  response_body    TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (from_lc, nonce)
);
CREATE INDEX payments_quote ON payments (quote_id);

-- Orders exist only after a successful settlement. pending_kind/pending_tx is the single in-flight chain
-- action for the order (claimed with a conditional UPDATE so the keeper and request paths never double-send).
CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  quote_id            TEXT NOT NULL UNIQUE,
  tier                TEXT NOT NULL,
  buyer_lc            TEXT NOT NULL,
  terms_hash          TEXT NOT NULL UNIQUE,
  escrow              TEXT NOT NULL,
  amount              TEXT NOT NULL,
  deadline            INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('funding','sealed','delivered','key_published','returned','void','failed')),
  funding             TEXT NOT NULL CHECK (funding IN ('confirmed','pending')),
  funding_tx          TEXT NOT NULL,
  funding_rail        TEXT NOT NULL CHECK (funding_rail IN ('relayer','payai','direct')),
  registered          INTEGER NOT NULL DEFAULT 0,
  manifest_hash       TEXT,
  delivered_at        INTEGER,
  deliver_tx          TEXT,
  accepted            INTEGER NOT NULL DEFAULT 0,
  decision_tx         TEXT,
  change_requested_at INTEGER,
  release_tx          TEXT,
  refund_tx           TEXT,
  cancel_tx           TEXT,
  to_seller           TEXT,
  to_buyer            TEXT,
  pending_kind        TEXT,
  pending_tx          TEXT,
  pending_since       INTEGER,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX orders_buyer ON orders (buyer_lc, created_at);
CREATE INDEX orders_status ON orders (status, updated_at);

-- Render / delivery jobs for the worker. status: queued -> claimed -> done | failed (re-queued on lease expiry).
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('instant_render','studio_delivery')),
  quote_id         TEXT NOT NULL,
  order_id         TEXT,
  status           TEXT NOT NULL CHECK (status IN ('queued','claimed','done','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL,
  worker_id        TEXT,
  lease_expires_at INTEGER,
  progress         INTEGER,
  still_key        TEXT,
  still_sha256     TEXT,
  preview_key      TEXT,
  preview_sha256   TEXT,
  manifest_json    TEXT,
  manifest_hash    TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX jobs_queue ON jobs (status, created_at);
CREATE INDEX jobs_quote ON jobs (quote_id);

-- Verified ciphertext chunks of a job's manifest (sha256 matched the manifest and the chunk decrypted).
CREATE TABLE job_chunks (
  job_id     TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, idx)
);

-- Relayer journal (written by the Durable Object). status: sent -> confirmed | reverted | dropped.
CREATE TABLE chain_txs (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  nonce      INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sent','confirmed','reverted','dropped')),
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chain_txs_status ON chain_txs (status, created_at);

-- OFAC SDN ETH list snapshots (0xB10C/ofac-sanctioned-digital-currency-addresses), newest wins.
CREATE TABLE sanctions_lists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  source     TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  addresses  TEXT NOT NULL
);

-- SIWE challenges (single use).
CREATE TABLE siwe_nonces (
  nonce      TEXT PRIMARY KEY,
  address_lc TEXT NOT NULL,
  message    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- Render-worker liveness (claim / heartbeat calls), used by the capacity gate and /health.
CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  seen_at   INTEGER NOT NULL
);

-- Leases for singleton background work (the cron keeper must not overlap itself).
CREATE TABLE locks (
  name       TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
