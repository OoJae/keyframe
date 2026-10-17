import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedRemoteUrl, loadBaseConfig, loadServiceConfig } from "../src/config.ts";

const TOKEN = "t".repeat(40);

describe("config", () => {
  it("base config needs nothing and has sane defaults", () => {
    const c = loadBaseConfig({});
    assert.equal(c.RENDER_WORKERS, "3");
    assert.equal(c.RENDER_CRF, 20);
    assert.equal(c.KEEP_JOBS, false);
    assert.match(c.TEMPLATES_DIR, /templates$/);
  });

  it("service config requires https API_BASE and a long token, and never echoes values", () => {
    const ok = loadServiceConfig({ API_BASE: "https://api.example.com/", WORKER_TOKEN: TOKEN });
    assert.equal(ok.API_BASE, "https://api.example.com");
    assert.equal(ok.RENDER_LANES, 1);
    const secret = "s3cr3t-value-that-is-too-short";
    assert.throws(
      () => loadServiceConfig({ API_BASE: "http://api.example.com", WORKER_TOKEN: secret }),
      (e: Error) => /API_BASE/.test(e.message) && /WORKER_TOKEN/.test(e.message) && !e.message.includes(secret),
    );
  });

  it("allows plain http only to loopback and never credentials in URLs", () => {
    assert.equal(isAllowedRemoteUrl("http://127.0.0.1:8787/x"), true);
    assert.equal(isAllowedRemoteUrl("http://localhost/x"), true);
    assert.equal(isAllowedRemoteUrl("http://10.0.0.2/x"), false);
    assert.equal(isAllowedRemoteUrl("https://user:pw@example.com/x"), false);
    assert.equal(isAllowedRemoteUrl("file:///etc/passwd"), false);
  });

  it("parses flags and bounds", () => {
    assert.equal(loadBaseConfig({ KEEP_JOBS: "1" }).KEEP_JOBS, true);
    assert.throws(() => loadBaseConfig({ RENDER_WORKERS: "12" }));
    assert.equal(loadBaseConfig({ RENDER_WORKERS: "auto" }).RENDER_WORKERS, "auto");
  });
});
