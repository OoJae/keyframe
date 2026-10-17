#!/usr/bin/env bash
# Local verification of the Keyframe interop spike (no real money).
#
# * Generates a TEST mnemonic in memory for this run only (never printed, never written to disk; it reaches
#   wrangler dev through the process environment and dies with this script).
# * Runs two `wrangler dev` instances: X402_MODE=v2 on :8787 and X402_MODE=v1 on :8788, both with
#   PUBLIC_BASE_URL=https://keyframe-spike.local (a canonical origin that differs from the local address on purpose).
# * Proves: quote creation, byte-identical 402 across POST/POST/GET with different Accept/UA/Host/proxy headers,
#   decoded accepts entry, payee == viem mnemonicToAccount(index), payee is codeless on Base mainnet (cast code),
#   unfunded-but-real signed payment is rejected by the facilitator with no settlement, request log, and the
#   spike plugin's keyframe_commission / keyframe_commission_direct / diag_* tools against the local server.
#
#   bash spike/server/scripts/local-verify.sh
set -euo pipefail

SERVER="$(cd "$(dirname "$0")/.." && pwd)"
SPIKE="$(cd "$SERVER/.." && pwd)"
REPO="$(cd "$SPIKE/.." && pwd)"
NODE_BIN="${NODE_BIN:-$REPO/.tools/node-v24.21.0-darwin-arm64/bin}"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v jq >/dev/null || { echo "jq is required"; exit 1; }

ORIGIN="https://keyframe-spike.local"
V2="http://127.0.0.1:8787"
V1="http://127.0.0.1:8788"
BUYER="0x1111111111111111111111111111111111111111"
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -INT "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n=== %s\n' "$*"; }
cmd() { printf '$ %s\n' "$*"; }

# ---------------------------------------------------------------- test mnemonic (memory only)
MN="$(cd "$SPIKE/tools" && node -e 'const a=require("viem/accounts");process.stdout.write(a.generateMnemonic(a.english))')"

start() { # name port inspector [VAR=VALUE ...]
  local name="$1" port="$2" insp="$3"; shift 3
  env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false CLOUDFLARE_INCLUDE_PROCESS_ENV=true \
    SPIKE_MNEMONIC="$MN" PUBLIC_BASE_URL="$ORIGIN" "$@" \
    "$SERVER/node_modules/.bin/wrangler" dev --config "$SERVER/wrangler.toml" --ip 127.0.0.1 --port "$port" \
    --inspector-port "$insp" --persist-to "$WORK/state-$name" --show-interactive-dev-session=false \
    >"$WORK/wrangler-$name.log" 2>&1 &
  PIDS+=("$!")
}
say "start wrangler dev instances with an in-memory test mnemonic (+ two local MOCK facilitators for the no-money paid path)"
cmd "env -i ... SPIKE_MNEMONIC=<in-memory test mnemonic> PUBLIC_BASE_URL=$ORIGIN X402_MODE=v2 wrangler dev --port 8787"
cmd "env -i ... SPIKE_MNEMONIC=<same> PUBLIC_BASE_URL=$ORIGIN X402_MODE=v1 wrangler dev --port 8788"
cmd "env -i ... X402_MODE=v2 FACILITATOR_URL=http://127.0.0.1:8790 PAID_BODY_PAD_BYTES=3500 wrangler dev --port 8789   # mock facilitator"
cmd "env -i ... X402_MODE=v1 FACILITATOR_URL=http://127.0.0.1:8790 wrangler dev --port 8793                             # mock facilitator"
cmd "env -i ... X402_MODE=v2 FACILITATOR_URL=http://127.0.0.1:8792 PAID_DELAY_MS=2000 SETTLE_MODE=broadcast wrangler dev --port 8791"
node "$SERVER/scripts/mock-facilitator.mjs" 8790 >"$WORK/mock-8790.log" 2>&1 & PIDS+=("$!")
node "$SERVER/scripts/mock-facilitator.mjs" 8792 >"$WORK/mock-8792.log" 2>&1 & PIDS+=("$!")
start v2 8787 9231 X402_MODE=v2
start v1 8788 9232 X402_MODE=v1
start mock 8789 9233 X402_MODE=v2 FACILITATOR_URL=http://127.0.0.1:8790 PAID_BODY_PAD_BYTES=3500
start mockv1 8793 9235 X402_MODE=v1 FACILITATOR_URL=http://127.0.0.1:8790
start delay 8791 9234 X402_MODE=v2 FACILITATOR_URL=http://127.0.0.1:8792 PAID_DELAY_MS=2000 SETTLE_MODE=broadcast
M="http://127.0.0.1:8789"; MV1="http://127.0.0.1:8793"; D="http://127.0.0.1:8791"
for url in "$V2" "$V1" "$M" "$MV1" "$D"; do
  for _ in $(seq 1 60); do curl -sf -m 2 "$url/health" >/dev/null && break; sleep 0.5; done
done
cmd "curl -s $V2/health"; curl -s "$V2/health" | jq -c .

# ---------------------------------------------------------------- input validation
say "strict input validation"
cmd "curl -s -X POST $V2/v1/spike/quotes -H 'content-type: application/json' -d '{\"buyer\":\"0x123\",\"amount\":\"100000\"}'"
curl -s -w '  -> HTTP %{http_code}\n' -X POST "$V2/v1/spike/quotes" -H 'content-type: application/json' -d '{"buyer":"0x123","amount":"100000"}'
cmd "curl -s -X POST $V2/v1/spike/quotes -H 'content-type: application/json' -d '{\"buyer\":\"$BUYER\",\"amount\":\"99999\"}'"
curl -s -w '  -> HTTP %{http_code}\n' -X POST "$V2/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"99999\"}"
cmd "curl -s -X POST $V2/v1/spike/quotes -H 'content-type: application/json' -d '{\"buyer\":\"$BUYER\",\"amount\":\"100000\",\"extra\":1}'"
curl -s -w '  -> HTTP %{http_code}\n' -X POST "$V2/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\",\"extra\":1}" | cut -c1-160

# ---------------------------------------------------------------- v2: quote + determinism
say "v2: create a quote"
cmd "curl -s -X POST $V2/v1/spike/quotes -H 'content-type: application/json' -d '{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}'"
QUOTE="$(curl -s -X POST "$V2/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}")"
echo "$QUOTE" | jq .
Q="$(echo "$QUOTE" | jq -r .quote_id)"; PAYTO="$(echo "$QUOTE" | jq -r .pay_to)"; IDX="$(echo "$QUOTE" | jq -r .pay_to_index)"

probe() { # label, curl args...
  local label="$1"; shift
  curl -s -D "$WORK/h" -o "$WORK/b" "$@"
  local status pr
  status="$(head -1 "$WORK/h" | awk '{print $2}')"
  pr="$(awk 'tolower($1)=="payment-required:"{print $2}' "$WORK/h" | tr -d '\r')"
  printf '%-34s HTTP %s  PAYMENT-REQUIRED sha256=%s  body=%s\n' "$label" "$status" \
    "$(printf %s "$pr" | shasum -a 256 | cut -c1-64)" "$(cat "$WORK/b")"
}
say "v2: fetch /v1/orders/$Q three times (POST, POST, GET) with different Accept / UA / Host / proxy headers"
cmd "curl -s -D - -X POST $V2/v1/orders/$Q -H 'accept: application/json'"
probe "1 POST accept=json, no body" -X POST "$V2/v1/orders/$Q" -H 'accept: application/json'
cmd "curl -s -D - -X POST $V2/v1/orders/$Q -H 'accept: text/html' -H 'user-agent: Mozilla/5.0' -H 'content-type: application/json' -d '{\"quote_id\":\"x\"}'"
probe "2 POST accept=html UA=Mozilla +body" -X POST "$V2/v1/orders/$Q" -H 'accept: text/html,application/xhtml+xml' -H 'user-agent: Mozilla/5.0 (Macintosh)' -H 'content-type: application/json' -d '{"quote_id":"x"}'
cmd "curl -s -D - $V2/v1/orders/$Q -H 'accept: */*' -H 'host: evil.example' -H 'x-forwarded-proto: http' -H 'x-forwarded-host: proxy.example'"
probe "3 GET accept=*/* Host/XFF spoofed" "$V2/v1/orders/$Q" -H 'accept: */*' -H 'host: evil.example' -H 'x-forwarded-proto: http' -H 'x-forwarded-host: proxy.example'

say "v2: decoded PAYMENT-REQUIRED"
cmd "curl -s -D - -o /dev/null -X POST $V2/v1/orders/$Q | awk 'tolower(\$1)==\"payment-required:\"{print \$2}' | tr -d '\\r' | base64 -d | jq ."
curl -s -D - -o /dev/null -X POST "$V2/v1/orders/$Q" | awk 'tolower($1)=="payment-required:"{print $2}' | tr -d '\r' | base64 -d | jq .

say "payee derivation parity: viem mnemonicToAccount(test mnemonic, {addressIndex: $IDX})"
cmd "SPIKE_MNEMONIC=<in-memory> node -e 'mnemonicToAccount(process.env.SPIKE_MNEMONIC,{addressIndex:$IDX}).address'"
DERIVED="$(cd "$SPIKE/tools" && SPIKE_MNEMONIC="$MN" node -e 'const a=require("viem/accounts");process.stdout.write(a.mnemonicToAccount(process.env.SPIKE_MNEMONIC,{addressIndex:Number(process.argv[1])}).address)' "$IDX")"
echo "derived=$DERIVED  quote.pay_to=$PAYTO  match=$([ "$DERIVED" = "$PAYTO" ] && echo yes || echo NO)"

say "payee is codeless on Base mainnet"
cmd "cast code $PAYTO --rpc-url https://mainnet.base.org"
cast code "$PAYTO" --rpc-url https://mainnet.base.org || echo "(cast unavailable or RPC unreachable)"

say "v2: paid-path probe with a real signature from an UNFUNDED ephemeral key (expect verify rejection, no settlement)"
cmd "pnpm exec tsx scripts/paid-probe.ts $V2/v1/orders/$Q"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-probe.ts "$V2/v1/orders/$Q") || true
cmd "curl -s $V2/v1/quotes/$Q | jq -c '{quote_id,status,order_id}'"
curl -s "$V2/v1/quotes/$Q" | jq -c '{quote_id,status,order_id}'

say "diag blob"
cmd "curl -s '$V2/v1/diag/blob?bytes=1048576' | wc -c"
curl -s "$V2/v1/diag/blob?bytes=1048576" | wc -c | tr -d ' '
cmd "curl -s -o /dev/null -w '%{http_code}\n' '$V2/v1/diag/blob?bytes=10485761'"
curl -s -o /dev/null -w '%{http_code}\n' "$V2/v1/diag/blob?bytes=10485761"

# ---------------------------------------------------------------- plugin against the local server
PLUGIN="$SPIKE/plugin/dist/plugin.mjs"
HARNESS="$SPIKE/tools/mcp-call.mjs"
say "spike plugin: keyframe_commission (v2) via MCP stdio harness"
cmd "KEYFRAME_API_BASE=$ORIGIN node spike/tools/mcp-call.mjs spike/plugin/dist/plugin.mjs keyframe_commission '{\"quote_id\":\"$Q\"}' --map $ORIGIN=$V2"
KEYFRAME_API_BASE="$ORIGIN" node "$HARNESS" "$PLUGIN" keyframe_commission "{\"quote_id\":\"$Q\"}" --map "$ORIGIN=$V2"
say "spike plugin: keyframe_commission_direct"
KEYFRAME_API_BASE="$ORIGIN" node "$HARNESS" "$PLUGIN" keyframe_commission_direct "{\"quote_id\":\"$Q\"}" --map "$ORIGIN=$V2"
cmd "cast calldata 'transfer(address,uint256)' $PAYTO 100000"
cast calldata 'transfer(address,uint256)' "$PAYTO" 100000 || true
say "spike plugin: diag_env (KEYFRAME_API_BASE set)"
KEYFRAME_API_BASE="$ORIGIN" node "$HARNESS" "$PLUGIN" diag_env '{}' | jq -c '{schema_check, structured: .result.structuredContent}'
say "spike plugin: diag_fetch (blobs from the local server; RPCs are real; no Alchemy key locally => 401 expected)"
KEYFRAME_API_BASE="$ORIGIN" node "$HARNESS" "$PLUGIN" diag_fetch '{}' --map "$ORIGIN=$V2" | jq -c '{call_ms, schema_check, results: [.result.structuredContent.results[] | {name,status,ok,ms,bytes,error}]}'
say "spike plugin: diag_paid_echo on a synthetic paid body (checksum built by the server's canonicalJson)"
SAMPLE="$(cd "$SERVER" && ./node_modules/.bin/tsx -e 'import {canonicalJson, sha256Hex} from "./src/ids.ts"; const core = {order_id:"o_11111111111111111111111", quote_id:"q_11111111111111111111111", amount:"100000", s7:{k_buyer_test:"ab".repeat(32), unicode:"Ключ · 鍵 · 🔑"}}; sha256Hex(canonicalJson(core)).then((checksum)=>process.stdout.write(JSON.stringify({status:"success", output:{response:{status:200, body: JSON.stringify({...core, checksum})}}})));')"
node "$HARNESS" "$PLUGIN" diag_paid_echo "{\"paid_response\":$SAMPLE}" | jq -c '{schema_check, structured: .result.structuredContent}'

# ---------------------------------------------------------------- v1 instance
say "v1 (X402_MODE=v1): quote + three fetches; challenge is the JSON body, no PAYMENT-REQUIRED header"
Q1="$(curl -s -X POST "$V1/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"8000000\"}" | jq -r .quote_id)"
echo "quote_id=$Q1"
for spec in "POST|application/json" "POST|text/html" "GET|*/*"; do
  m="${spec%%|*}"; a="${spec##*|}"
  cmd "curl -s -X $m $V1/v1/orders/$Q1 -H 'accept: $a' | shasum -a 256"
  hdr="$(curl -s -D - -o /dev/null -X "$m" "$V1/v1/orders/$Q1" | awk 'tolower($1)=="payment-required:"{print "present"}' | head -1)"
  printf 'body sha256=%s  PAYMENT-REQUIRED header=%s\n' "$(curl -s -X "$m" "$V1/v1/orders/$Q1" -H "accept: $a" -H 'user-agent: Mozilla/5.0' | shasum -a 256 | cut -c1-64)" "${hdr:-absent}"
done
curl -s -X POST "$V1/v1/orders/$Q1" | jq .
say "v1: plugin keyframe_commission parses the v1 body"
KEYFRAME_API_BASE="$ORIGIN" node "$HARNESS" "$PLUGIN" keyframe_commission "{\"quote_id\":\"$Q1\"}" --map "$ORIGIN=$V1" | jq -c '{schema_check, proposal: .result.structuredContent, text: .result.content[0].text}'
say "v1: paid-path probe (X-PAYMENT, unfunded ephemeral key; official client cap is \$1, so use a 0.10 quote)"
Q1S="$(curl -s -X POST "$V1/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-probe.ts "$V1/v1/orders/$Q1S") || true


# ---------------------------------------------------------------- paid path against MOCK facilitators (no chain)
say "MOCK facilitator, v2: paid 200 + PAYMENT-RESPONSE, idempotent replay, 409 for a second nonce, 409 for unpaid-after-paid"
QM="$(curl -s -X POST "$M/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
cmd "tsx scripts/paid-flow.ts full $M/v1/orders/$QM http://127.0.0.1:8790/stats"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-flow.ts full "$M/v1/orders/$QM" http://127.0.0.1:8790/stats) | cut -c1-900
say "MOCK facilitator, v2: client echoes a cosmetically different accepted block -> tolerant rewrite, still settles once"
QX="$(curl -s -X POST "$M/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-flow.ts mangled "$M/v1/orders/$QX" http://127.0.0.1:8790/stats)
curl -s "$M/v1/diag/log?quote_id=$QX" | jq -c '[.entries[] | {payment_header_name, status, note}]'
say "MOCK facilitator, v1 wire: X-PAYMENT -> 200 + X-PAYMENT-RESPONSE, replay, 409"
QV="$(curl -s -X POST "$MV1/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-flow.ts full "$MV1/v1/orders/$QV" http://127.0.0.1:8790/stats) | cut -c1-900
say "S7 rehearsal: padded paid body (PAID_BODY_PAD_BYTES=3500) wrapped like a get_request output -> diag_paid_echo"
QS7="$(curl -s -X POST "$M/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
PAIDBODY="$(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-flow.ts raw "$M/v1/orders/$QS7")"
echo "paid body bytes: $(printf %s "$PAIDBODY" | wc -c | tr -d ' ')"
node "$HARNESS" "$PLUGIN" diag_paid_echo "{\"paid_response\":{\"status\":\"success\",\"output\":{\"response\":{\"status\":200,\"body\":$PAIDBODY}}}}" | jq -c '{schema_check, structured: .result.structuredContent}'
say "PAID_DELAY_MS=2000: client gives up after 500 ms. NOTE: under local wrangler dev request.signal never fires on disconnect, so the server still verifies+settles here; the abort guard can only be observed on the deployed Worker (S8)"
QD="$(curl -s -X POST "$D/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-flow.ts abort "$D/v1/orders/$QD" http://127.0.0.1:8792/stats 500)
curl -s "$D/v1/diag/log?quote_id=$QD" | jq -c '[.entries[] | {method, payment_header_name, status, ms, note}]'
say "SETTLE_MODE=broadcast (deferred): 200 right after verify (+2 s delay), settlement completes in the background"
QD2="$(curl -s -X POST "$D/v1/spike/quotes" -H 'content-type: application/json' -d "{\"buyer\":\"$BUYER\",\"amount\":\"100000\"}" | jq -r .quote_id)"
(cd "$SERVER" && ./node_modules/.bin/tsx scripts/paid-flow.ts once "$D/v1/orders/$QD2" http://127.0.0.1:8792/stats) | cut -c1-600
sleep 1
curl -s "$D/v1/diag/log?quote_id=$QD2" | jq -c '{order, entries: [.entries[] | {method, payment_header_name, status, ms, note}]}'

# ---------------------------------------------------------------- request log
sleep 1
say "request log for the v2 quote"
cmd "curl -s '$V2/v1/diag/log?quote_id=$Q' | jq ..."
curl -s "$V2/v1/diag/log?quote_id=$Q" | jq '{count, unpaid_402_count, distinct_unpaid_402_payment_required_sha256, deterministic_402, entries: [.entries[] | {method, ua, accept, content_length, body_bytes, payment_header_name, x402_version_of_payload, sha: (.payment_required_sha256 // "" | .[0:16]), status, ms, note}]}'

say "secret hygiene"
echo "mnemonic occurrences in wrangler logs: $(cat "$WORK"/wrangler-*.log | grep -c -F "$MN" || true)"
echo "mnemonic occurrences under spike/ (excluding node_modules): $(grep -rIl -F "$MN" "$SPIKE" --exclude-dir=node_modules 2>/dev/null | wc -l | tr -d ' ')"
