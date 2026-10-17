import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { viemChainReader } from "../src/chain.js";

// workerd cancels a request whose only pending I/O belongs to another request. viem's batch scheduler is shared per
// URL across the isolate, so the chain reader must never batch: every read of a request has to be that request's
// own fetch. (Found on the Base-fork e2e: two concurrent payments for one quote → one 500 "code had hung".)

describe("viemChainReader transport", () => {
  const bodies: string[] = [];
  let url = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    bodies.push(body);
    const one = (m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, result: `0x${"0".repeat(63)}1` });
    const parsed = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends concurrent reads (even from two readers on one URL) as separate, unbatched requests", async () => {
    const a = viemChainReader(url);
    const b = viemChainReader(url);
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const who = "0x1111111111111111111111111111111111111111";
    const out = await Promise.all([a.balanceOf(usdc, who), b.balanceOf(usdc, who), a.balanceOf(usdc, usdc)]);
    expect(out).toEqual([1n, 1n, 1n]);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(Array.isArray(JSON.parse(body))).toBe(false);
  });
});
