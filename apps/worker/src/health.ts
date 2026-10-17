import { createServer, type Server } from "node:http";
import type { Logger } from "./log.ts";

// Liveness and readiness for Docker HEALTHCHECK and monitoring. Read-only, no secrets: job ids, stages and counters.
//   GET /healthz → 200 while the process is serving (status, lanes, counters, last API contact).
//   GET /readyz  → 200 when the worker can take jobs (preflight ok, not draining, API reached recently), else 503.

export type HealthSource = { status(): unknown; ready(): boolean };
export type HealthServer = { port: number; close(): Promise<void> };

export async function startHealthServer(
  host: string,
  port: number,
  src: HealthSource,
  log: Logger,
): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "method not allowed" });
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/healthz") return send(200, src.status());
    if (url === "/readyz") return src.ready() ? send(200, { ready: true }) : send(503, { ready: false });
    return send(404, { error: "not found" });
  });
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  log.info({ host, port: bound }, "health server listening");
  return {
    port: bound,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
