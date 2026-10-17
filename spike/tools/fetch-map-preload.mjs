// Test-only preload for the MCP harness: maps one https origin to a local origin for fetch(), the equivalent of a
// hosts-file entry plus TLS termination. Lets the unmodified dist/plugin.mjs (which only accepts https:443 API bases,
// as PayBox requires) talk to `wrangler dev` on localhost. Never used in production; PayBox does not load it.
//
//   SPIKE_FETCH_MAP="https://keyframe-spike.local=http://127.0.0.1:8787" node --import ./fetch-map-preload.mjs plugin.mjs

const spec = process.env.SPIKE_FETCH_MAP ?? "";
const [from, to] = spec.split("=");
if (from && to) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === from || url.startsWith(`${from}/`)) return original(`${to}${url.slice(from.length)}`, init);
    return original(input, init);
  };
}
