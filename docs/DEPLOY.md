# Deploy runbook: Arbitrum Sepolia, Robinhood Chain testnet, notes.markets

Everything below runs from the repo root on the server. Keys live in `.keys/` (gitignored, mode 600) and are read
from files by the scripts, never typed on a command line or printed.

| Key | Address | Role |
|---|---|---|
| `.keys/deployer.json` | `0x298afB9424188C7eA7c01556D8CAE6ff4768de0a` | Deploys and owns the engine, test tokens and faucet; issuer and paying agent of the seeded demo notes |
| `.keys/keeper.json` | `0xcA06AbE78eCBcC861a8eE12fd980035dC91d118f` | Pays gas for the CRE simulator's `--broadcast` reports |
| `.keys/investor1.json`, `investor2.json` | created by `scripts/seed-note.ts` | Demo investors in the seeded notes (the deployer sends each 0.001 ETH for gas) |

The deployer is also the **issuer** of the seeded notes: it pledges their tUSD collateral and, through
`scripts/issuer-bot.ts` (pm2 `sn-arb-issuer-<chain>`), funds each payment as it falls due, minting test tUSD as the
token's owner. Each funding costs about 0.22M gas.

## 1. Fund the two addresses

Measured on a local fork of Arbitrum Sepolia (`REHEARSAL=1 bash scripts/deploy-testnets.sh`): the whole deployment
(engine, lens, 8 test tokens, faucet, minter and drip settings) is **27 transactions, 13.86M gas**. The engine alone
estimates at 5.33M gas on both live testnets (`cast estimate`, read-only, 2026-10-23). Gas prices that day: Arbitrum
Sepolia 0.020 gwei, Robinhood Chain testnet 0.010 gwei.

| Address | Arbitrum Sepolia | Robinhood Chain testnet | What it covers |
|---|---|---|---|
| Deployer `0x298a…de0a` | **0.02 ETH** | **0.02 ETH** | Deployment (~0.0003 ETH at today's price), two seeded notes, 0.002 ETH passed to the demo investors, and room for gas-price spikes |
| Keeper `0xcA06…118f` | **0.03 ETH** | **0.03 ETH** | Reports: 0.2–0.5M gas each for a small book; a coupon to a full book of 62 holders 2.3M, a default paying three assets to 62 holders 5.0M (6M limit); several hundred reports at today's prices |

Faucets: Arbitrum Sepolia, https://faucets.chain.link/arbitrum-sepolia (or bridge Sepolia ETH); Robinhood Chain
testnet, https://faucet.testnet.chain.robinhood.com.

## 2. Deploy the contracts

```bash
REHEARSAL=1 SEED=1 bash scripts/deploy-testnets.sh   # optional: the same against local forks first
bash scripts/deploy-testnets.sh                      # both testnets: writes deployments/<chain>.json,
                                                     # cre/notes-keeper-evm/config.staging.json, deployments/server/*.json
```

The engine trusts each chain's **MockKeystoneForwarder** (what `cre workflow simulate --broadcast` writes through).
The fallback reporter stays off. Commit `deployments/*.json` and the generated configs afterwards.

## 3. Database, indexer and API (pm2)

These commands create new resources on this server. They don't touch the existing cloudflared tunnel, the
splice-validator containers or other pm2 processes. Run them after approval.

```bash
# Postgres 16, local only, persistent volume
PGPASS="$(openssl rand -hex 24)"
docker run -d --name sn-arb-pg --restart unless-stopped -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=sn -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=stratosnotes \
  -v sn-arb-pgdata:/var/lib/postgresql/data postgres:16-alpine

# Secrets for the services (never committed)
umask 077
printf 'DATABASE_URL=postgres://sn:%s@127.0.0.1:55432/stratosnotes\nSN_PROXY_SECRET=%s\n' "$PGPASS" "$(openssl rand -hex 32)" > .env.server
unset PGPASS

# Email (docs/NOTIFICATIONS.md): the relay secret the API and the Worker share, and the verifier key that signs
# on-chain email attestations (its address is the engine's verifier: scripts/deploy-testnets.sh reads it)
printf 'EMAIL_RELAY_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.server
[ -f .keys/verifier.json ] || (cast wallet new --json > .keys/verifier.json && chmod 600 .keys/verifier.json)

pm2 start ops/ecosystem.config.cjs --only sn-arb-indexer,sn-arb-api
curl -s http://127.0.0.1:8787/api/health      # the indexer's cursor per chain
```

The API also runs the email notifier (no separate process). Alerts go out once Email Sending is onboarded for
notes.markets (docs/NOTIFICATIONS.md, "Turning on Email Sending"); until then the outbox holds them.

## 4. Public API hostname: a separate Cloudflare Tunnel

A new tunnel with its own credentials directory, so the existing `/etc/cloudflared` tunnel and
`~/.cloudflared/cert.pem` are left alone. The login opens a browser link: pick the **stratoslab.app** zone in account
`325f8b322c30ee0f5460cfdaef82ecf5`.

```bash
mkdir -p /root/.cloudflared-notes
HOME=/root/.cloudflared-notes cloudflared tunnel login
HOME=/root/.cloudflared-notes cloudflared tunnel create sn-arb-api
HOME=/root/.cloudflared-notes cloudflared tunnel route dns sn-arb-api api.notes.markets
TID="$(HOME=/root/.cloudflared-notes cloudflared tunnel list -o json | python3 -c "import json,sys;print([t['id'] for t in json.load(sys.stdin) if t['name']=='sn-arb-api'][0])")"
cat > /root/.cloudflared-notes/config.yml <<EOF
tunnel: $TID
credentials-file: /root/.cloudflared-notes/.cloudflared/$TID.json
ingress:
  - hostname: api.notes.markets
    service: http://127.0.0.1:8787
  - service: http_status:404
EOF
pm2 start cloudflared --name sn-arb-tunnel -- tunnel --no-autoupdate --config /root/.cloudflared-notes/config.yml run sn-arb-api
curl -s https://api.notes.markets/api/health
```

## 5. The site Worker (notes.markets)

```bash
(cd web && npm install)
# the same SN_PROXY_SECRET as .env.server, so the API trusts the client IP the Worker forwards
grep '^SN_PROXY_SECRET=' .env.server | cut -d= -f2 | (cd web && CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5 npx wrangler secret put SN_PROXY_SECRET)
# the same EMAIL_RELAY_SECRET as .env.server, for /internal/email (the API's email relay)
grep '^EMAIL_RELAY_SECRET=' .env.server | cut -d= -f2 | (cd web && CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5 npx wrangler secret put EMAIL_RELAY_SECRET)
npm run deploy        # landing-proof from deployments/*.json, build landing + app, wrangler deploy (custom domain)
```

## 6. Keeper, seed data, templates

```bash
cd cre && cre whoami && cd ..                          # the CRE CLI must be logged in
pm2 start ops/ecosystem.config.cjs --only sn-arb-keeper
pm2 start ops/ecosystem.config.cjs --only sn-arb-issuer-arbitrum-sepolia,sn-arb-issuer-robinhood-testnet  # the issuer funds its notes
bash scripts/seed.sh                                   # one demo note per chain + the template library
# To show a default: leave one note's payment unfunded, e.g. pid 2's first payment on Arbitrum Sepolia
MISS=2:1 pm2 restart sn-arb-issuer-arbitrum-sepolia --update-env
pm2 logs sn-arb-keeper --lines 20                      # "... Task_FixStrike [...] -> written 0x…"
```

## 7. Record the evidence

After a seeded note completes, add its transactions to `docs/evidence.json` (see `scripts/landing-proof.ts` for the
shape) and to docs/SUBMISSION.md, then `npm run deploy` again so the landing page shows them.

## 8. Cutover to Cloudflare D1 (the whole backend on the Worker)

All internal data moves to D1: the indexer's read model, templates, email subscriptions (emails and salts),
verification codes, preferences and the notification outbox (`web/migrations/`). The Worker serves the API from
D1 and runs the indexer and the notifier on a one-minute cron (`services/edge`, wrangler environment `edge`).
Afterwards only the CRE keeper and the issuer bots run on this server; Postgres, `sn-arb-indexer`, `sn-arb-api`
and the `sn-arb-tunnel` (api.notes.markets) are retired.

Rehearse first, locally: `E2E=1 bash scripts/dev-local-d1.sh` (anvil fork + `wrangler dev --local` with a local
D1 + the app end-to-end check).

```bash
cd web
export CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5

# 1. Create the database, put its id into wrangler.jsonc (env.edge.d1_databases[0].database_id), commit.
npx wrangler d1 create notes-markets

# 2. Schema.
npx wrangler d1 migrations apply DB --remote --env edge

# 3. Deploy the edge Worker, still proxying the API to the server while D1 backfills.
#    (Set "API_MODE": "proxy" in env.edge.vars for this deploy.)
bash build.sh && npx wrangler deploy --env edge
#    Secrets do not carry over between environments: set them for env edge.
grep '^SN_PROXY_SECRET=' ../.env.server | cut -d= -f2 | npx wrangler secret put SN_PROXY_SECRET --env edge

# 4. Backfill: the cron indexes from each engine's deployment block (deployments/server/indexer.json startBlock).
#    Watch it catch up; the cursor per chain should reach the head within a few cron runs.
npx wrangler tail --env edge --format json | grep '"cron":"indexer"'
npx wrangler d1 execute DB --remote --env edge --command "SELECT chain, cursor, head, updated_at FROM chains"

# 5. Templates: re-seed the library through the API once it serves from D1 (they are signed; no copy needed),
#    or copy them from Postgres:
#    psql "$DATABASE_URL" -Atc "SELECT json_agg(t) FROM templates t" > /tmp/templates.json   then insert via
#    `npx wrangler d1 execute DB --remote --env edge --file <generated inserts.sql>`.

# 6. Switch: "API_MODE": "edge" in env.edge.vars (the default), redeploy, verify.
bash build.sh && npx wrangler deploy --env edge
curl -s https://notes.markets/api/health          # chains with cursor near head, served by the Worker
curl -s "https://notes.markets/api/notes?limit=5" # the live notes
curl -s "https://notes.markets/api/updates"       # {"seq":…,"changes":[]}

# 7. Retire the old backend (only after 6 verifies).
pm2 delete sn-arb-indexer sn-arb-api sn-arb-tunnel && pm2 save
docker stop sn-arb-pg   # keep the volume a while as a backup; `docker rm sn-arb-pg` later
HOME=/root/.cloudflared-notes cloudflared tunnel delete sn-arb-api   # and remove the api.notes.markets DNS record
```

Notes:
- Email: when notes.markets is onboarded for Email Sending, add the `send_email` binding (`EMAIL`) to `env.edge`
  and set `"EMAIL_SENDING": "on"`. Until then the outbox fills and nothing is sent.
- A redeployed engine on a chain: the indexer refuses a chain row whose engine changed. Index the new engine
  under a new key (e.g. `arbitrum-sepolia-v2`), or reset the chain: delete its rows from `chains`, `blocks`,
  `events`, `definitions`, and its notes/holdings/note_underlyings (`WHERE chain = …` / `note_id LIKE '<chain>:%'`).
- Limits per cron run (services/edge/src/scheduled.ts): ≤ 800 D1 queries of the 1,000 allowed, ≤ 700 RPC calls
  of the 1,000 subrequests allowed (paid plan; the free plan's 50 subrequests is too few), 20 s of wall time.
  Each batch is at most 150 events and 25 notes, cut at a block boundary.
