import { spawn } from "node:child_process";

// Child processes (hyperframes, ffmpeg) run in their own process group so a timeout or cancellation can take
// down Chrome and every helper it started, and they get an allowlisted environment: the worker's bearer token
// and any other secret in process.env never reach them.

const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LANG",
  "LC_ALL",
  "XDG_CACHE_HOME",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE",
  "HYPERFRAMES_BROWSER_PATH",
  "PRODUCER_HEADLESS_SHELL_PATH",
  "PRODUCER_LOW_MEMORY_MODE",
  "PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS",
  "PRODUCER_PLAYER_READY_TIMEOUT_MS",
  "HYPERFRAMES_EXTRACT_CACHE_DIR",
  "HYPERFRAMES_FFMPEG_PATH",
  "HYPERFRAMES_FFPROBE_PATH",
] as const;

/** Telemetry, update checks, skill downloads and runtime auto-installs are always off (builder's notes §1). */
export const QUIET_ENV: Readonly<Record<string, string>> = {
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_SKIP_SKILLS: "1",
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
  DO_NOT_TRACK: "1",
  TZ: "UTC",
};

export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH) {
    const v = source[key];
    if (v !== undefined && v !== "") env[key] = v;
  }
  return { ...env, ...QUIET_ENV };
}

export type ProcFailure = "timeout" | "aborted" | "exit" | "spawn";

export class ProcError extends Error {
  override name = "ProcError";
  readonly kind: ProcFailure;
  readonly command: string;
  readonly result?: ProcResult;
  constructor(kind: ProcFailure, command: string, message: string, result?: ProcResult) {
    super(message);
    this.kind = kind;
    this.command = command;
    this.result = result;
  }
}

export type ProcResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line (for progress parsing). */
  onStdoutLine?: (line: string) => void;
  /** Keep at most this many trailing bytes of each stream (default 64 KiB). */
  maxCaptureBytes?: number;
  /** Grace period between SIGTERM and SIGKILL to the process group. */
  killGraceMs?: number;
};

class Tail {
  private chunks: string[] = [];
  private size = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()?.length ?? 0;
  }
  toString(): string {
    const s = this.chunks.join("");
    return s.length > this.max ? s.slice(s.length - this.max) : s;
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

/** Run a command to completion. Rejects with ProcError on spawn failure, timeout, abort or non-zero exit. */
export function run(command: string, args: readonly string[], opts: RunOptions): Promise<ProcResult> {
  const maxCapture = opts.maxCaptureBytes ?? 64 * 1024;
  const graceMs = opts.killGraceMs ?? 5_000;
  const label = command.split("/").pop() ?? command;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ProcError("aborted", label, `${label}: aborted before start`));
      return;
    }
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out = new Tail(maxCapture);
    const err = new Tail(maxCapture);
    let pending = "";
    let failure: ProcFailure | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (why: ProcFailure) => {
      if (failure) return;
      failure = why;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs);
      killTimer.unref();
    };
    const timer = setTimeout(() => terminate("timeout"), opts.timeoutMs);
    const onAbort = () => terminate("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out.push(chunk);
      if (!opts.onStdoutLine) return;
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        opts.onStdoutLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      if (pending.length > maxCapture) pending = pending.slice(-maxCapture);
    });
    child.stderr.on("data", (chunk: string) => err.push(chunk));

    const finish = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      finish();
      reject(new ProcError("spawn", label, `${label}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      finish();
      // The leader exited; make sure no orphan (for example a Chrome helper) outlives it.
      killGroup(child.pid, "SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      const result: ProcResult = {
        code,
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        durationMs: Math.round(performance.now() - started),
      };
      if (failure === "timeout") {
        reject(new ProcError("timeout", label, `${label}: timed out after ${opts.timeoutMs} ms`, result));
      } else if (failure === "aborted") {
        reject(new ProcError("aborted", label, `${label}: aborted`, result));
      } else if (code !== 0) {
        const tail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
        reject(new ProcError("exit", label, `${label}: exit ${code ?? signal}${tail ? `\n${tail}` : ""}`, result));
      } else {
        resolve(result);
      }
    });
  });
}
