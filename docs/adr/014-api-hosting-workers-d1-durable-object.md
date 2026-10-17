# ADR-014: Hosting: Cloudflare Workers + D1 + KV/R2 + a relayer Durable Object + Cron

- Status: accepted (engineering), for the builder's review. It supersedes architecture.md §e.1 (Postgres on Node).
- Date: 2026-10-17
- Area: `apps/api`
- Numbering: the slot reserved for this topic in `docs/design/verification.md` §6.

## Context

architecture.md proposed Hono on Node with Postgres. The reconciled plan (PLAN.md) and the build task chose
Workers. The API needs four things: exactly-once compare-and-set, a job queue for the render worker, one serialized
nonce sequence for the hot relayer key, a per-minute keeper, and public immutable file hosting. It must not need
a server to babysit.

## Decision

- **Workers + Hono** for HTTP. All business logic is plain TypeScript behind small interfaces (`SqlDb`,
  `StorageAdapter`, `ChainReader`, `RelayerClient`), so it runs unchanged under Node tests and in workerd.
- **D1** for all state (`migrations/0001_init.sql`). Every transition is a conditional `UPDATE … WHERE status = …`
  whose `changes` count is the CAS result. Job claims use `UPDATE … RETURNING`. Multi-row bookkeeping uses `batch`,
  which runs in one transaction.
- **StorageAdapter**: R2 when the `FILES` binding exists, otherwise KV. Public files use the frozen layout
  (`c/{manifestHash}/…`, plus per-attempt still and preview keys) and are served by `GET /files/*` unless
  `FILES_BASE_URL` points at an R2 custom domain.
- **Relayer Durable Object** (singleton `relayer/v1`, SQLite-backed). It holds the operator key's nonce and its
  raw-transaction store, and it is the only signer. It can only call `FACTORY_ADDRESS`.
- **Cron `* * * * *`** runs the keeper. It confirms funding, registers PayAI-funded escrows, releases, refunds after
  the deadline, sends `refundExpired(20)`, scans for direct-rail deposits, re-queues expired render leases,
  refreshes the OFAC list and reconciles the journal.
- Secrets live in Workers secrets: `KMASTER`, `RELAYER_PRIVATE_KEY`, `WORKER_TOKEN`, `ACCESS_SECRET`, and `RPC_URL` if
  it embeds a key. Everything else is a var in `wrangler.toml`.

## Consequences

- Bundle size is 1.58 MiB (321 KiB gzip). **Workers Paid is required.** Signature recovery, x402 verification and the
  KFC1 self-verification (every chunk is decrypted) use more CPU than the Free plan's 10 ms per request, and the
  budget item is already in PLAN.md ($5/month).
- D1 is SQLite. The unit tests run the real migrations on Node's built-in `node:sqlite` behind a D1-shaped shim,
  and `wrangler dev` runs them on workerd's D1.
- Single-region D1 adds latency for far-away callers. That is acceptable for an x402 resource whose slow step is
  the chain.
