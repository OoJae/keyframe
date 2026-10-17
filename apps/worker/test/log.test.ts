import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeUrl } from "../src/log.ts";
import { captureLogger } from "./helpers.ts";

describe("logging", () => {
  it("safeUrl drops query strings (presigned signatures) and fragments", () => {
    assert.equal(
      safeUrl("https://r2.example.com/c/abc/0.bin?X-Amz-Signature=deadbeef#frag"),
      "https://r2.example.com/c/abc/0.bin",
    );
    assert.equal(safeUrl("not a url"), "[invalid-url]");
  });

  it("redacts url, authorization and token fields", () => {
    const { log, text } = captureLogger();
    log.info(
      { url: "https://x/y?sig=1", headers: { authorization: "Bearer abc" }, token: "tok", job: { uploads: { a: 1 } } },
      "m",
    );
    const out = text();
    assert.ok(!out.includes("sig=1") && !out.includes("Bearer abc") && !out.includes('"tok"'));
    assert.match(out, /\[redacted\]/);
  });
});
