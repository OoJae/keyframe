#!/usr/bin/env bash
# Keyframe mainnet deploy (Base). Staged and idempotent; never prints secret values.
#
#   scripts/deploy-mainnet.sh plan                 # predicted addresses + readiness checks (no transactions)
#   scripts/deploy-mainnet.sh factory --broadcast  # deploy KeyframeEscrowFactory (CREATE2) + verify on Sourcify/Blockscout
#   scripts/deploy-mainnet.sh relayer [--fund 0.0015]  # create RELAYER_PRIVATE_KEY in .env if missing; optionally fund it from the deployer
#   scripts/deploy-mainnet.sh api                  # write wrangler.production.toml, secrets, D1 migrations, deploy the API
#   scripts/deploy-mainnet.sh portal               # print the PayBox developer-portal values for the plugin
#
# Inputs (.env, gitignored): SELLER_ADDRESS, DEPLOYER_PRIVATE_KEY, ALCHEMY_API_KEY. Generated into .env when missing:
# RELAYER_PRIVATE_KEY, KMASTER, ACCESS_SECRET, WORKER_TOKEN (back these up: KMASTER derives every order's keys).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$ROOT/.env"
export PATH="$ROOT/.tools/node-v24.21.0-darwin-arm64/bin:$PATH"
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
CF_SUBDOMAIN="keyframe-spike-server.workers.dev"
API_NAME="keyframe-api"
PUBLIC_BASE_URL="https://${API_NAME}.${CF_SUBDOMAIN}"
D1_ID="e025cc17-93dd-40d8-9bb7-7e4a251a1cb0"
KV_ID="8e2b0d9a8a2f469f8ee9d2fd5af7193d"
R2_BUCKET="keyframe-files"

die() { echo "error: $*" >&2; exit 1; }
[ -f "$ENVF" ] || die "missing $ENVF"
set -a; . "$ENVF"; set +a
RPC="https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY:?ALCHEMY_API_KEY missing in .env}"

put_env() { # put_env NAME VALUE — append if absent; never echoes VALUE
  grep -q "^$1=" "$ENVF" || printf '%s=%s\n' "$1" "$2" >> "$ENVF"
}
rand_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

need_seller() {
  [ -n "${SELLER_ADDRESS:-}" ] || die "add SELLER_ADDRESS=0x… (studio payout wallet B) to .env first"
  cast to-check-sum-address "$SELLER_ADDRESS" >/dev/null || die "SELLER_ADDRESS is not a valid address"
}

predict() {
  need_seller
  (cd "$ROOT/contracts" && USDC=$USDC SELLER=$SELLER_ADDRESS forge script script/Deploy.s.sol --rpc-url "$RPC" 2>/dev/null) \
    | grep -E "predicted|initCodeHash|SELLER|already|simulated" || die "forge script simulation failed (run it manually to see why)"
}

factory_addr() {
  (cd "$ROOT/contracts" && USDC=$USDC SELLER=$SELLER_ADDRESS forge script script/Deploy.s.sol --rpc-url "$RPC" 2>/dev/null) \
    | awk '/predicted factory/{print $NF}'
}

cmd_plan() {
  predict
  local dep; dep=$(cast wallet address --private-key "${DEPLOYER_PRIVATE_KEY:?}")
  echo "deployer         $dep  balance $(cast balance "$dep" --ether --rpc-url "$RPC") ETH"
  if [ -n "${RELAYER_PRIVATE_KEY:-}" ]; then
    local rel; rel=$(cast wallet address --private-key "$RELAYER_PRIVATE_KEY")
    echo "relayer/operator $rel  balance $(cast balance "$rel" --ether --rpc-url "$RPC") ETH"
  else echo "relayer          (not created yet: scripts/deploy-mainnet.sh relayer)"; fi
  echo "api              $PUBLIC_BASE_URL"
}

cmd_factory() {
  need_seller
  [ "${1:-}" = "--broadcast" ] || { predict; echo "dry run only; re-run with --broadcast to deploy"; return; }
  (cd "$ROOT/contracts" && USDC=$USDC SELLER=$SELLER_ADDRESS forge script script/Deploy.s.sol \
      --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast 2>&1 | grep -vi "private" | tail -25)
  local f impl; f=$(factory_addr); impl=$(cast compute-address "$f" --nonce 1 | awk '{print $NF}')
  [ "$(cast code "$f" --rpc-url "$RPC")" != "0x" ] || die "factory not deployed at $f"
  echo "factory $f  vaultImpl $impl"
  local args; args=$(cast abi-encode "constructor(address,address)" "$USDC" "$SELLER_ADDRESS")
  for v in sourcify blockscout; do
    local extra=(); [ "$v" = blockscout ] && extra=(--verifier-url https://base.blockscout.com/api/)
    (cd "$ROOT/contracts" && forge verify-contract --chain 8453 --verifier "$v" "${extra[@]}" \
        --constructor-args "$args" "$f" src/KeyframeEscrowFactory.sol:KeyframeEscrowFactory 2>&1 | tail -2) || echo "($v verify: retry later)"
    (cd "$ROOT/contracts" && forge verify-contract --chain 8453 --verifier "$v" "${extra[@]}" \
        "$impl" src/KeyframeVault.sol:KeyframeVault 2>&1 | tail -2) || true
  done
}

cmd_relayer() {
  if [ -z "${RELAYER_PRIVATE_KEY:-}" ]; then
    put_env RELAYER_PRIVATE_KEY "0x$(rand_hex 32)"; set -a; . "$ENVF"; set +a; echo "created RELAYER_PRIVATE_KEY in .env"
  fi
  local rel; rel=$(cast wallet address --private-key "$RELAYER_PRIVATE_KEY")
  echo "relayer/operator $rel  balance $(cast balance "$rel" --ether --rpc-url "$RPC") ETH"
  if [ "${1:-}" = "--fund" ]; then
    local amt="${2:?amount in ETH}"
    cast send "$rel" --value "${amt}ether" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" 2>&1 | grep -E "transactionHash|status" || true
    echo "relayer balance now $(cast balance "$rel" --ether --rpc-url "$RPC") ETH"
  fi
}

cmd_api() {
  need_seller
  [ -n "${RELAYER_PRIVATE_KEY:-}" ] || die "run: scripts/deploy-mainnet.sh relayer first"
  local f; f=$(factory_addr); [ "$(cast code "$f" --rpc-url "$RPC")" != "0x" ] || die "deploy the factory first ($f has no code)"
  put_env KMASTER "$(rand_hex 32)"; put_env ACCESS_SECRET "$(rand_hex 32)"; put_env WORKER_TOKEN "$(rand_hex 32)"
  set -a; . "$ENVF"; set +a
  cd "$ROOT/apps/api"
  sed -e "s|database_id = \"00000000-0000-0000-0000-000000000000\"|database_id = \"$D1_ID\"|" \
      -e "s|^id = \"00000000000000000000000000000000\"|id = \"$KV_ID\"|" \
      -e "s|^# \[\[r2_buckets\]\]|[[r2_buckets]]|" -e "s|^# binding = \"FILES\"|binding = \"FILES\"|" \
      -e "s|^# bucket_name = \"keyframe-files\"|bucket_name = \"$R2_BUCKET\"|" \
      -e "s|PUBLIC_BASE_URL = \".*\"|PUBLIC_BASE_URL = \"$PUBLIC_BASE_URL\"|" \
      -e "s|FACTORY_ADDRESS = \".*\"|FACTORY_ADDRESS = \"$f\"|" \
      -e "s|SELLER_ADDRESS = \".*\"|SELLER_ADDRESS = \"$(cast to-check-sum-address "$SELLER_ADDRESS")\"|" \
      -e "s|^RPC_URL = .*|# RPC_URL is a secret (carries the Alchemy key)|" \
      wrangler.toml > wrangler.production.toml
  grep -q "database_id = \"$D1_ID\"" wrangler.production.toml || die "could not set D1 id"
  for s in KMASTER ACCESS_SECRET WORKER_TOKEN RELAYER_PRIVATE_KEY; do
    printf %s "${!s}" | pnpm exec wrangler secret put "$s" -c wrangler.production.toml >/dev/null && echo "secret $s set"
  done
  printf %s "$RPC" | pnpm exec wrangler secret put RPC_URL -c wrangler.production.toml >/dev/null && echo "secret RPC_URL set"
  pnpm exec wrangler d1 migrations apply keyframe --remote -c wrangler.production.toml 2>&1 | tail -3
  pnpm exec wrangler deploy -c wrangler.production.toml 2>&1 | grep -E "Deployed|workers.dev|Version|rror"
  curl -fsS "$PUBLIC_BASE_URL/health" | head -c 400; echo
  curl -fsS -X POST "$PUBLIC_BASE_URL/internal/sanctions/refresh" -H "authorization: Bearer $WORKER_TOKEN" | head -c 200; echo
}

cmd_portal() {
  need_seller
  local f impl rel; f=$(factory_addr); impl=$(cast compute-address "$f" --nonce 1 | awk '{print $NF}')
  rel=$(cast wallet address --private-key "${RELAYER_PRIVATE_KEY:?run relayer first}")
  cat <<EOF
Developer portal → Test & configure
  Network hosts:  ${PUBLIC_BASE_URL#https://}   mainnet.base.org   base-rpc.publicnode.com
  Environment variables:
    KEYFRAME_API_BASE   = $PUBLIC_BASE_URL
    KEYFRAME_FILES_BASE = $PUBLIC_BASE_URL/files
    KEYFRAME_FACTORIES  = [{"address":"$f","vaultImpl":"$impl","status":"active"}]
    KEYFRAME_SELLERS    = $(cast to-check-sum-address "$SELLER_ADDRESS")
    KEYFRAME_OPERATORS  = $rel
    KEYFRAME_RPC_URLS   = https://mainnet.base.org,https://base-rpc.publicnode.com
  Upload: $ROOT/plugin/dist/plugin.mjs  (sha256 $(shasum -a 256 "$ROOT/plugin/dist/plugin.mjs" | cut -c1-64))
EOF
}

case "${1:-plan}" in
  plan) cmd_plan ;;
  factory) shift; cmd_factory "$@" ;;
  relayer) shift; cmd_relayer "$@" ;;
  api) cmd_api ;;
  portal) cmd_portal ;;
  *) die "unknown command $1" ;;
esac
