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

pm2 start ops/ecosystem.config.cjs --only sn-arb-indexer,sn-arb-api
curl -s http://127.0.0.1:8787/api/health      # the indexer's cursor per chain
```

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
