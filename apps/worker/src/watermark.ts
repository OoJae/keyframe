import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import path from "node:path";
import { type FfOptions, lumaToAlpha } from "./ffmpeg.ts";
import { removeDir } from "./files.ts";
import { type BrowserGpu, snapshot } from "./hyperframes.ts";
import type { Logger } from "./log.ts";
import { stamp } from "./stamp.ts";
import { ASPECTS, type Aspect, loadTemplate } from "./templates.ts";

// The preview watermark is the `_watermark` composition (white on black), snapshotted once per aspect and turned
// into an RGBA tile (alpha = luma × overlay.opacity). Tiles are cached on disk under a key derived from the
// watermark's template hash and opacity, so a redesign invalidates them and a restart does not re-render them.

export const WATERMARK_ID = "_watermark";

export type TileOptions = {
  templatesDir: string;
  workDir: string;
  ff: Omit<FfOptions, "signal">;
  browserGpu: BrowserGpu;
  snapshotTimeoutMs: number;
};

export class Tiles {
  private readonly pending = new Map<Aspect, Promise<string>>();
  private readonly opts: TileOptions;
  private readonly log: Logger;
  constructor(opts: TileOptions, log: Logger) {
    this.opts = opts;
    this.log = log;
  }

  /** Path to the RGBA tile for an aspect, rendering it on first use. */
  get(aspect: Aspect): Promise<string> {
    let p = this.pending.get(aspect);
    if (!p) {
      p = this.build(aspect);
      p.catch(() => this.pending.delete(aspect));
      this.pending.set(aspect, p);
    }
    return p;
  }

  private async build(aspect: Aspect): Promise<string> {
    const tpl = await loadTemplate(this.opts.templatesDir, WATERMARK_ID);
    const opacity = tpl.meta.overlay?.opacity ?? 0.22;
    const key = createHash("sha256").update(`${tpl.hash}|${opacity}`).digest("hex").slice(0, 16);
    const dir = path.join(this.opts.workDir, "tiles", key);
    const out = path.join(dir, `${ASPECTS[aspect].slug}.png`);
    if (existsSync(out)) return out;

    await mkdir(dir, { recursive: true });
    const tmp = await mkdtemp(path.join(dir, `.build-${ASPECTS[aspect].slug}-`));
    const started = performance.now();
    try {
      const stamped = await stamp({
        templatesDir: this.opts.templatesDir,
        template: tpl,
        aspect,
        durationS: tpl.meta.durations[0] ?? 1,
        style: tpl.meta.styles[0] ?? "reference",
        values: {},
        outDir: path.join(tmp, "comp"),
      });
      const frame = await snapshot(stamped.dir, stamped.heroTimeS, path.join(tmp, "snap"), {
        timeoutMs: this.opts.snapshotTimeoutMs,
        browserGpu: this.opts.browserGpu,
      });
      const staged = path.join(tmp, "tile.png");
      await lumaToAlpha(frame, staged, { width: stamped.width, height: stamped.height }, opacity, this.opts.ff);
      await rename(staged, out);
      this.log.info({ aspect, key, ms: Math.round(performance.now() - started) }, "watermark tile ready");
      return out;
    } finally {
      await removeDir(tmp);
    }
  }
}
