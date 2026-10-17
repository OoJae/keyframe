import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { childEnv, type ProcError, QUIET_ENV, run } from "../src/proc.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("childEnv", () => {
  it("passes only the allowlist plus the quiet flags", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/h",
      WORKER_TOKEN: "x",
      API_BASE: "https://a",
      GEMINI_API_KEY: "k",
      HYPERFRAMES_API_KEY: "k",
    });
    assert.equal(env.HYPERFRAMES_NO_TELEMETRY, "1");
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", ...QUIET_ENV });
  });
});

describe("run", () => {
  it("returns output on success and streams stdout lines", async () => {
    const lines: string[] = [];
    const r = await run("/bin/sh", ["-c", "echo one; echo two"], {
      timeoutMs: 5_000,
      onStdoutLine: (l) => lines.push(l),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(lines, ["one", "two"]);
  });

  it("rejects a non-zero exit with the stderr tail", async () => {
    await assert.rejects(
      run("/bin/sh", ["-c", "echo boom >&2; exit 3"], { timeoutMs: 5_000 }),
      (e: ProcError) => e.kind === "exit" && /boom/.test(e.message),
    );
  });

  it("kills the whole process group on timeout", async () => {
    let grandchild = 0;
    await assert.rejects(
      run("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], {
        timeoutMs: 400,
        killGraceMs: 200,
        onStdoutLine: (l) => {
          grandchild = Number(l);
        },
      }),
      (e: ProcError) => e.kind === "timeout",
    );
    await delay(300);
    assert.ok(grandchild > 0 && !alive(grandchild), "background child is gone too");
  });

  it("aborts on signal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(
      run("/bin/sh", ["-c", "sleep 30"], { timeoutMs: 10_000, signal: ac.signal }),
      (e: ProcError) => e.kind === "aborted",
    );
  });

  it("does not leak the parent's secrets to children", async () => {
    process.env.WORKER_TOKEN = "never-in-a-child-0123456789abcdef0123456789";
    try {
      const r = await run("/usr/bin/env", [], { timeoutMs: 5_000 });
      assert.ok(!r.stdout.includes("never-in-a-child"));
      assert.match(r.stdout, /HYPERFRAMES_NO_TELEMETRY=1/);
    } finally {
      delete process.env.WORKER_TOKEN;
    }
  });
});
