#!/usr/bin/env bash
# Deploy StratosNotes to the testnets: FlowEngine (CRE MockKeystoneForwarder, fallback reporter OFF), NotesLens,
# the test tokens (tUSD, tETH, tBTC, tSOL, tTSLA, tNVDA, tAAPL, tSPY) and their TokenFaucet. Writes
# deployments/<chain>.json, then the CRE staging config and the server configs (scripts/server-config.ts).
#
#   bash scripts/deploy-testnets.sh                          # both chains
#   CHAINS=robinhood-testnet bash scripts/deploy-testnets.sh # one chain
#   REHEARSAL=1 bash scripts/deploy-testnets.sh              # against local anvil forks; writes deployments/local/rehearsal/
#   REHEARSAL=1 SEED=1 bash scripts/deploy-testnets.sh       # ... and issue a demo note per chain on them
#
# The deployer key is read from .keys/deployer.json (never printed) and is OWNER of the engine, tokens and faucet.
# Re-running redeploys: move deployments/<chain>.json aside first if you mean to keep the old one.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
CHAINS="${CHAINS:-arbitrum-sepolia robinhood-testnet}"
declare -A RPC=( [arbitrum-sepolia]="${RPC_ARBITRUM_SEPOLIA:-https://sepolia-rollup.arbitrum.io/rpc}" [robinhood-testnet]="${RPC_ROBINHOOD_TESTNET:-https://rpc.testnet.chain.robinhood.com}" )
declare -A ID=( [arbitrum-sepolia]=421614 [robinhood-testnet]=46630 )
OUTDIR="deployments"
[ -f .keys/deployer.json ] || { echo "missing .keys/deployer.json (cast wallet new --json > .keys/deployer.json)"; exit 1; }
DEPLOYER="$(python3 -c "import json;print(json.load(open('.keys/deployer.json'))[0]['address'])")"

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
if [ "${REHEARSAL:-0}" = "1" ]; then
  OUTDIR="deployments/local/rehearsal"
  port=28600
  for c in $CHAINS; do
    port=$((port + 1))
    anvil --fork-url "${RPC[$c]}" --chain-id "${ID[$c]}" --port "$port" --silent & PIDS+=($!)
    for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && break; sleep 1; done
    cast rpc anvil_setBalance "$DEPLOYER" 0x8AC7230489E80000 --rpc-url "http://127.0.0.1:$port" >/dev/null   # 10 ETH, fork only
    RPC[$c]="http://127.0.0.1:$port"
  done
fi
mkdir -p "$OUTDIR"

for c in $CHAINS; do
  rpc="${RPC[$c]}"
  [ "$(cast chain-id --rpc-url "$rpc")" = "${ID[$c]}" ] || { echo "$c: RPC $rpc is not chain ${ID[$c]}"; exit 1; }
  bal="$(cast balance "$DEPLOYER" --rpc-url "$rpc" --ether)"
  echo "== $c: deployer $DEPLOYER has $bal ETH"
  python3 -c "import sys; sys.exit(0 if float('$bal') >= 0.002 else 1)" || { echo "$c: fund the deployer first (docs/DEPLOY.md)"; exit 1; }
  # The key reaches the script through DEPLOYER_KEY in this one command's environment: never on a command line,
  # never echoed.
  (cd packages/evm-engine && export DEPLOYER_KEY="$(python3 -c "import json;k=json.load(open('$ROOT/.keys/deployer.json'))[0]['private_key'];print(k if k.startswith('0x') else '0x'+k)")" && \
    CHAIN="$c" FORWARDER_MODE=mock OWNER="$DEPLOYER" TEST_TOKENS=1 OUT="$ROOT/$OUTDIR/$c.json" \
    forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --slow > "$ROOT/$OUTDIR/deploy-$c.log" 2>&1) \
    || { echo "$c: deploy failed (see $OUTDIR/deploy-$c.log)"; exit 1; }
  echo "   $(python3 -c "import json;d=json.load(open('$OUTDIR/$c.json'));print('engine',d['engine'],'lens',d['lens'],'faucet',d['faucet'])")"
done

# Rehearsal only: also issue a demo note per chain on the forks (scripts/seed-note.ts), as scripts/seed.sh would.
if [ "${REHEARSAL:-0}" = "1" ] && [ "${SEED:-0}" = "1" ]; then
  for c in $CHAINS; do
    echo "== seed: $c"
    CHAIN="$c" RPC="${RPC[$c]}" DEPLOY_DIR="$OUTDIR" NOTE="$([ "$c" = robinhood-testnet ] && echo equity || echo crypto)" npx tsx scripts/seed-note.ts
  done
fi

if [ "$OUTDIR" = "deployments" ]; then
  npx tsx scripts/cre-config.ts staging
  npx tsx scripts/server-config.ts
fi
echo "done: $OUTDIR/"
