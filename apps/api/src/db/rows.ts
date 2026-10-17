// Row shapes of migrations/0001_init.sql. Booleans are INTEGER 0/1; times are unix seconds.

export type QuoteStatus = "draft" | "final" | "settling" | "paid" | "expired" | "cancelled";

export interface QuoteRow {
  id: string;
  status: QuoteStatus;
  tier: "instant" | "studio";
  format: string;
  catalog_id: string;
  buyer: string;
  buyer_lc: string;
  amount: string;
  delivery: "public" | "private";
  hero_ms: number;
  spec_json: string;
  spec_hash: string;
  terms_json: string;
  terms_hash: string;
  escrow: string;
  data_snapshot: string | null;
  still_url: string | null;
  still_sha256: string | null;
  preview_url: string | null;
  manifest_hash: string | null;
  eta_s: number;
  quote_expires_at: number;
  deadline: number;
  pay_from: string | null;
  pay_nonce: string | null;
  order_id: string | null;
  cancel_reason: string | null;
  created_at: number;
  finalized_at: number | null;
  updated_at: number;
}

export interface PaymentRow {
  from_lc: string;
  nonce: string;
  quote_id: string;
  status: "settling" | "settled" | "failed";
  wire: "v1" | "v2";
  rail: string | null;
  tx_hash: string | null;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type OrderStatus = "funding" | "sealed" | "delivered" | "key_published" | "returned" | "void" | "failed";
export type PendingKind = "register" | "release" | "deliver" | "decide" | "refund" | "cancel";

export interface OrderRow {
  id: string;
  quote_id: string;
  tier: "instant" | "studio";
  buyer_lc: string;
  terms_hash: string;
  escrow: string;
  amount: string;
  deadline: number;
  status: OrderStatus;
  funding: "confirmed" | "pending";
  funding_tx: string;
  funding_rail: "relayer" | "payai" | "direct";
  registered: number;
  manifest_hash: string | null;
  delivered_at: number | null;
  deliver_tx: string | null;
  accepted: number;
  decision_tx: string | null;
  change_requested_at: number | null;
  release_tx: string | null;
  refund_tx: string | null;
  cancel_tx: string | null;
  to_seller: string | null;
  to_buyer: string | null;
  pending_kind: PendingKind | null;
  pending_tx: string | null;
  pending_since: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type JobKind = "instant_render" | "studio_delivery";

export interface JobRow {
  id: string;
  kind: JobKind;
  quote_id: string;
  order_id: string | null;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  lease_expires_at: number | null;
  progress: number | null;
  still_key: string | null;
  still_sha256: string | null;
  preview_key: string | null;
  preview_sha256: string | null;
  manifest_json: string | null;
  manifest_hash: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
