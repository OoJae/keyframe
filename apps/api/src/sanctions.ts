import { sha256Hex } from "@keyframe/protocol";
import type { Repo } from "./db/repo.js";

// OFAC SDN screening (architecture.md §b.5/§c.3): 0xB10C's machine-readable ETH list, cached in D1 and in the
// isolate. Fail-closed: if the newest list is older than OFAC_MAX_AGE_S (and a refresh fails), screening
// reports "unavailable" and money paths answer 503 without charging.

export type ScreenResult = "clear" | "sanctioned" | "unavailable";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIN_ENTRIES = 10;
const ISOLATE_CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;
const REFRESH_BACKOFF_MS = 60_000;

interface Loaded {
  set: ReadonlySet<string>;
  fetchedAt: number;
  loadedAtMs: number;
}

export interface SanctionsOptions {
  listUrl: string;
  maxAgeS: number;
  fetch: typeof fetch;
  nowMs: () => number;
}

export class Sanctions {
  private loaded: Loaded | null = null;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;

  private readonly repo: Repo;
  private readonly opts: SanctionsOptions;

  constructor(repo: Repo, opts: SanctionsOptions) {
    this.repo = repo;
    this.opts = opts;
  }

  private nowS(): number {
    return Math.floor(this.opts.nowMs() / 1000);
  }

  private async load(force = false): Promise<Loaded | null> {
    const now = this.opts.nowMs();
    if (!force && this.loaded && now - this.loaded.loadedAtMs < ISOLATE_CACHE_MS) return this.loaded;
    const row = await this.repo.latestSanctionsList();
    if (!row) return null;
    const list = JSON.parse(row.addresses) as string[];
    this.loaded = { set: new Set(list), fetchedAt: row.fetched_at, loadedAtMs: now };
    return this.loaded;
  }

  private fresh(l: Loaded | null): l is Loaded {
    return l !== null && this.nowS() - l.fetchedAt <= this.opts.maxAgeS;
  }

  async status(): Promise<{ fresh: boolean; fetched_at: number | null; count: number }> {
    const l = await this.load();
    return { fresh: this.fresh(l), fetched_at: l?.fetchedAt ?? null, count: l?.set.size ?? 0 };
  }

  async screen(address: string): Promise<ScreenResult> {
    let l = await this.load();
    if (!this.fresh(l) && this.opts.nowMs() - this.lastAttemptMs >= REFRESH_BACKOFF_MS) {
      await this.refresh().catch(() => undefined);
      l = await this.load(true);
    }
    if (!this.fresh(l)) return "unavailable";
    return l.set.has(address.toLowerCase()) ? "sanctioned" : "clear";
  }

  /** Fetch, validate and store a new snapshot. Keeps the previous one on any anomaly. */
  async refresh(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
    this.lastAttemptMs = this.opts.nowMs();
    let body: unknown;
    try {
      const res = await this.opts.fetch(this.opts.listUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
        redirect: "follow",
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      body = JSON.parse(await res.text());
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.name : "fetch_failed" };
    }
    if (!Array.isArray(body) || !body.every((a) => typeof a === "string" && ADDRESS.test(a))) {
      return { ok: false, error: "malformed_list" };
    }
    const addresses = [...new Set((body as string[]).map((a) => a.toLowerCase()))].sort();
    if (addresses.length < MIN_ENTRIES) return { ok: false, error: "list_too_small" };
    const prev = await this.load(true);
    if (prev && addresses.length < prev.set.size / 2) return { ok: false, error: "list_shrank_suspiciously" };
    const json = JSON.stringify(addresses);
    await this.repo.insertSanctionsList({
      fetched_at: this.nowS(),
      source: this.opts.listUrl,
      sha256: await sha256Hex(json),
      count: addresses.length,
      addresses: json,
    });
    this.loaded = null;
    return { ok: true, count: addresses.length };
  }
}
