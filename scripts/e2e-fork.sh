#!/usr/bin/env bash
# Keyframe end to end on a local anvil fork of Base mainnet (real FiatTokenV2_2 USDC), re-runnable:
#   scripts/e2e-fork.sh                 # pinned fork block (FORK_BLOCK, default below)
#   FORK_BLOCK=52710000 KEEP_STATE=1 scripts/e2e-fork.sh
# Needs: anvil/forge/cast (Foundry 1.8.x), ffmpeg, apps/worker `npm ci` + the HyperFrames browser, the root pnpm
# install, and plugin/dist/plugin.mjs built (cd plugin && pnpm run build). ALCHEMY_API_KEY comes from .env and is
# never printed: it is only part of anvil's --fork-url and is redacted from every log. Nothing is broadcast to
# mainnet; all transactions go to the local fork. Artifacts: .e2e/<run>/ (gitignored); the run's secret env files
# are deleted when it ends. See docs/evidence/INTEGRATION.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$ROOT/.tools/node-v24.21.0-darwin-arm64/bin"
if [[ -x "$NODE_BIN/node" ]]; then export PATH="$NODE_BIN:$PATH"; fi
if [[ "$(node --version)" != "v24.21.0" ]]; then
  echo "e2e-fork: Node 24.21.0 required (found $(node --version))" >&2
  exit 2
fi
for bin in anvil forge cast ffmpeg ffprobe; do
  command -v "$bin" >/dev/null || { echo "e2e-fork: $bin not found on PATH" >&2; exit 2; }
done
[[ -f "$ROOT/plugin/dist/plugin.mjs" ]] || { echo "e2e-fork: build the plugin first (cd plugin && pnpm run build)" >&2; exit 2; }

if [[ -z "${ALCHEMY_API_KEY:-}" && -f "$ROOT/.env" ]]; then
  ALCHEMY_API_KEY="$(grep -E '^ALCHEMY_API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '\r"'"'"' ')"
fi
[[ -n "${ALCHEMY_API_KEY:-}" ]] || { echo "e2e-fork: ALCHEMY_API_KEY missing (.env)" >&2; exit 2; }
export ALCHEMY_API_KEY
export FORK_URL="https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}"
export FORK_BLOCK="${FORK_BLOCK:-52710000}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export E2E_RUN_DIR="${E2E_RUN_DIR:-$ROOT/.e2e/$RUN_ID}"
mkdir -p "$E2E_RUN_DIR"
echo "e2e-fork: run dir $E2E_RUN_DIR (fork block $FORK_BLOCK)"

# Contracts must be built for the deploy script and the driver's ABI (cached after the first build).
(cd "$ROOT/contracts" && forge build >/dev/null)

cd "$ROOT/apps/api"
exec node scripts/e2e-fork.mjs
