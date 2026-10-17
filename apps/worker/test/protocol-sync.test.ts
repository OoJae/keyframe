import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { WORKER_ROOT } from "../src/config.ts";

const exec = promisify(execFile);

describe("vendored @keyframe/protocol", () => {
  it("src/protocol is byte-identical to packages/protocol/src (scripts/sync-protocol.mjs --check)", async () => {
    const script = path.resolve(WORKER_ROOT, "../../scripts/sync-protocol.mjs");
    const { stdout } = await exec(process.execPath, [
      script,
      "--target",
      path.join(WORKER_ROOT, "src/protocol"),
      "--check",
    ]);
    assert.match(stdout, /matches/);
  });
});
