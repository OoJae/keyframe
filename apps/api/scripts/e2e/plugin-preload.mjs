// e2e-only preload for the plugin process (never part of the bundle; PayBox never loads it). The bundle only accepts
// https origins on port 443, so this stands in for a hosts-file entry plus TLS termination: every https request to a
// host listed in KF_E2E_HOSTS is sent to its local http target; every other request fails like an unreachable network
// (the embedded production defaults are never contacted). Same idea as plugin/test/harness/fetch-map.mjs, with a
// per-host map so API, files and two "independent" RPC hosts can point at different local services.
//
// KF_E2E_CLOCK_OFFSET_MS (optional) shifts Date.now() for this process. It is used only after the fork's clock has
// been advanced with evm_setNextBlockTimestamp, so the plugin's wall clock agrees with Base time again, as it would
// in production where block time and wall time move together.
//
//   KF_E2E_HOSTS='{"api.kf.test":"http://127.0.0.1:8787"}' node --import ./plugin-preload.mjs plugin/dist/plugin.mjs

const hosts = JSON.parse(process.env.KF_E2E_HOSTS ?? "{}");
const offset = Number(process.env.KF_E2E_CLOCK_OFFSET_MS ?? "0");
if (Number.isFinite(offset) && offset !== 0) {
  const real = Date.now.bind(Date);
  Date.now = () => real() + offset;
}

const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const target = url.protocol === "https:" && (url.port === "" || url.port === "443") ? hosts[url.hostname] : undefined;
  if (typeof target !== "string") {
    return Promise.reject(new TypeError("fetch failed", { cause: new Error("blocked by the e2e harness") }));
  }
  const mapped = `${target}${url.pathname}${url.search}`;
  if (typeof input === "object" && !(input instanceof URL)) return original(new Request(mapped, input), init);
  return original(mapped, init);
};
