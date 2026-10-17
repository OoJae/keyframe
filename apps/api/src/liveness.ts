import type { Config } from "./config.js";
import { nowS, type Services } from "./services.js";

// Render-studio liveness. A render worker is "seen" when it polls for instant_render jobs or renews the lease of
// one; the Studio CLI's human deliveries never count. Instant quotes are refused while the studio is offline
// (nothing would render them), and /v1/styles and /health report the same state.

export const STUDIO_OFFLINE =
  "Keyframe's render studio is offline right now; nothing was charged. Studio (hand-made) commissions are still open.";

/** A worker row is rewritten at most this often (≤ a quarter of WORKER_STALE_S, so liveness never flaps). */
export const touchIntervalS = (cfg: Pick<Config, "workerStaleS">): number =>
  Math.min(30, Math.floor(cfg.workerStaleS / 4));

export const touchRenderWorker = (s: Services, workerId: string): Promise<boolean> =>
  s.repo.touchWorker(workerId, nowS(s), touchIntervalS(s.cfg));

export interface RenderLiveness {
  online: boolean;
  /** Seconds since a render worker was last recorded (null: never). */
  lastSeenAgoS: number | null;
}

export async function renderLiveness(s: Services): Promise<RenderLiveness> {
  const seen = await s.repo.lastWorkerSeen();
  const ago = seen === null ? null : Math.max(0, nowS(s) - seen);
  return { online: ago !== null && ago <= s.cfg.workerStaleS, lastSeenAgoS: ago };
}
