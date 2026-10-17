// LOCAL TEST ONLY: a fake x402 facilitator so the spike server's paid path (settle, idempotent replay, 409,
// abort-before-settle, deferred settle) can be exercised without money. It accepts any exact EVM payment whose
// authorization matches the requirements and returns a fake transaction hash. It never touches a chain.
//
//   node scripts/mock-facilitator.mjs 8790      then point FACILITATOR_URL at http://127.0.0.1:8790
//   GET /stats -> {verify, settle} call counts

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8790);
const stats = { verify: 0, settle: 0 };

function check(body) {
  const p = body?.paymentPayload;
  const r = body?.paymentRequirements;
  const auth = p?.payload?.authorization;
  if (!auth || !r) return { ok: false, reason: "invalid_payload" };
  const amount = r.amount ?? r.maxAmountRequired;
  if (String(auth.to).toLowerCase() !== String(r.payTo).toLowerCase()) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
  if (String(auth.value) !== String(amount)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value" };
  return { ok: true, payer: auth.from, network: r.network, nonce: auth.nonce };
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/stats") return send(200, stats);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(400, { error: "bad json" });
    }
    const c = check(body);
    if (req.url === "/verify") {
      stats.verify++;
      return send(200, c.ok ? { isValid: true, payer: c.payer } : { isValid: false, invalidReason: c.reason });
    }
    if (req.url === "/settle") {
      stats.settle++;
      if (!c.ok) return send(200, { success: false, errorReason: c.reason, transaction: "", network: body?.paymentRequirements?.network ?? "eip155:8453" });
      const tx = `0x${createHash("sha256").update(`mock:${c.nonce}`).digest("hex")}`;
      return send(200, { success: true, transaction: tx, network: c.network, payer: c.payer });
    }
    send(404, { error: "not found" });
  });
}).listen(port, "127.0.0.1", () => console.log(`mock facilitator on http://127.0.0.1:${port}`));
