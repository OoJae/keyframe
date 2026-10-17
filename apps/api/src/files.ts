import { error } from "./http.js";
import type { Services } from "./services.js";
import { IMMUTABLE_CACHE, isPublicKey, parseRange, readRange } from "./storage.js";
import { previewPageUrl, watchUrl } from "./web/links.js";

// GET /files/* (public artifact storage when FILES_BASE_URL points here). Immutable bytes with single byte ranges
// (iOS plays MP4 only from servers that answer Range with 206). A browser navigating to a KFC1 manifest URL, the one
// keyframe_verify prints, is sent to the order's watch page instead; agents and the plugin (Accept: application/json,
// */* or none) always get the stored manifest bytes.

const MANIFEST_KEY = /^c\/(0x[0-9a-f]{64})\/manifest\.json$/;

const BASE_HEADERS = {
  "Cache-Control": IMMUTABLE_CACHE,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Accept-Ranges": "bytes",
};

/** A browser navigation: asks for HTML and not for JSON. */
export function wantsHtml(accept: string | null | undefined): boolean {
  const a = (accept ?? "").toLowerCase();
  return a.includes("text/html") && !a.includes("application/json");
}

/** The human page for a manifest: the order's watch page, else the committing quote's preview page. */
async function pageForManifest(s: Services, manifestHash: string): Promise<string | null> {
  const owner = await s.repo.ownerOfManifest(manifestHash);
  if (!owner) return null;
  return owner.order_id ? watchUrl(s.cfg, owner.order_id) : previewPageUrl(s.cfg, owner.quote_id);
}

export async function serveFile(s: Services, key: string, req: Request): Promise<Response> {
  if (!isPublicKey(key)) return error(404, { error: "not_found" });
  const manifest = MANIFEST_KEY.exec(key);
  if (manifest?.[1] && wantsHtml(req.headers.get("accept"))) {
    const to = await pageForManifest(s, manifest[1]);
    if (to)
      return new Response(null, {
        status: 302,
        headers: { Location: to, Vary: "Accept", "Cache-Control": "no-store" },
      });
  }
  // The manifest URL now answers differently by Accept: keep shared caches from mixing the two.
  const headers: Record<string, string> = manifest ? { ...BASE_HEADERS, Vary: "Accept" } : { ...BASE_HEADERS };

  const spec = parseRange(req.headers.get("range"));
  if (spec) {
    const part = await readRange(s.storage, key, spec);
    if (!part) return error(404, { error: "not_found" });
    if (!part.range) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Cache-Control": "no-store", "Content-Range": `bytes */${part.size}` },
      });
    }
    const { offset, length } = part.range;
    return new Response(part.bytes, {
      status: 206,
      headers: {
        ...headers,
        "Content-Type": part.contentType,
        "Content-Length": String(length),
        "Content-Range": `bytes ${offset}-${offset + length - 1}/${part.size}`,
      },
    });
  }

  const obj = await s.storage.get(key);
  if (!obj) return error(404, { error: "not_found" });
  return new Response(obj.bytes, {
    status: 200,
    headers: { ...headers, "Content-Type": obj.contentType, "Content-Length": String(obj.bytes.byteLength) },
  });
}
