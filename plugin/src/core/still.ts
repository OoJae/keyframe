// Fetches the watermarked key-frame still and checks its sha256 against the hash committed in the spec. Only
// fetched from Keyframe's own file or API origin (configured hosts); anything else is reported, not fetched.

import type { Hex } from "viem";
import { sha256Hex } from "../protocol/index.js";
import { type Check, fail, pass, skip } from "./checks.js";
import type { Config } from "./config.js";
import { type Budget, describeNetError, fetchBounded, NetError } from "./net.js";

const STILL_CAP_MS = 3_000;
const MAX_STILL_BYTES = 3 * 1024 * 1024;

function allowedOrigin(cfg: Config, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return false;
    const origins = [cfg.filesBase, cfg.apiBase].map((b) => new URL(b).origin);
    return origins.includes(u.origin);
  } catch {
    return false;
  }
}

export async function checkStill(
  cfg: Config,
  budget: Budget,
  url: string | null,
  committed: Hex | null,
): Promise<Check> {
  const id = "preview_matches_deal";
  if (url === null || committed === null) return skip(id, "no key-frame still in this quote yet");
  if (!allowedOrigin(cfg, url))
    return skip(id, "the still is hosted outside Keyframe's file host, so it was not fetched");
  try {
    const res = await fetchBounded(url, { method: "GET", headers: { accept: "image/*" } }, budget, {
      capMs: STILL_CAP_MS,
      maxBytes: MAX_STILL_BYTES,
    });
    if (res.status !== 200) return skip(id, `the still could not be downloaded (HTTP ${res.status})`);
    const got = await sha256Hex(res.bytes);
    return got === committed.toLowerCase()
      ? pass(id, "the key-frame preview you see is exactly the still committed in the deal (sha256 match)")
      : fail(id, "the downloaded key-frame still does NOT match the hash committed in the deal");
  } catch (error) {
    if (error instanceof NetError) return skip(id, `the still download ${describeNetError(error)}`);
    throw error;
  }
}
