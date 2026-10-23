#!/usr/bin/env bash
# Seed the live testnets after scripts/deploy-testnets.sh: one short-dated demo note per chain (a worst-of phoenix
# on ETH/BTC on Arbitrum Sepolia, on TSLA/NVDA on Robinhood Chain testnet) with part of the book sold, and the
# template library through the API.
#
#   bash scripts/seed.sh                         # notes + templates (API=https://notes.markets)
#   STRIKE_IN=1800 OBS_EVERY=600 bash scripts/seed.sh
#   SKIP_TEMPLATES=1 bash scripts/seed.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CRYPTO_CHAIN="${CRYPTO_CHAIN:-arbitrum-sepolia}"
EQUITY_CHAIN="${EQUITY_CHAIN:-robinhood-testnet}"
CHAIN="$CRYPTO_CHAIN" NOTE=crypto npx tsx scripts/seed-note.ts
CHAIN="$EQUITY_CHAIN" NOTE=equity npx tsx scripts/seed-note.ts
if [ "${SKIP_TEMPLATES:-0}" != "1" ]; then
  API="${API:-https://notes.markets}" npx tsx scripts/seed-templates.ts
fi
