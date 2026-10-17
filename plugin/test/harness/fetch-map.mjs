// Test-only preload for the stdio harness: routes https://*.kf.test to the local mock server, the equivalent of a
// hosts-file entry plus TLS termination. The bundle stays byte-for-byte what is uploaded (it only accepts https
// origins); PayBox never loads this file. Every other host fails like an unreachable network, keeping tests
// hermetic (the embedded production defaults are never contacted).
//
//   KF_TEST_FETCH_TARGET=http://127.0.0.1:PORT node --import ./fetch-map.mjs dist/plugin.mjs

const target = process.env.KF_TEST_FETCH_TARGET;
if (target) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".kf.test")) {
      return Promise.reject(new TypeError("fetch failed", { cause: new Error("blocked by test harness") }));
    }
    const headers = new Headers(init?.headers);
    headers.set("x-kf-host", url.host);
    return original(`${target}${url.pathname}${url.search}`, { ...init, headers });
  };
}
