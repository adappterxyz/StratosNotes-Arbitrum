# Demo script (4 minutes)

A note's life takes longer than a pitch, so one is issued before you present and its strike lands while you talk;
a second is issued live.

## Before you present

1. **Services up:** `pm2 status` shows `sn-arb-indexer`, `sn-arb-api`, `sn-arb-tunnel` and `sn-arb-keeper` online;
   `curl -s https://notes.markets/api/health` lists both chains with a moving cursor.
2. **A note in flight** (about 20 minutes ahead), its strike ~3 minutes into the talk:
   ```bash
   CHAIN=arbitrum-sepolia NOTE=crypto STRIKE_IN=1380 OBS_EVERY=120 npx tsx scripts/seed-note.ts
   ```
3. **Wallet:** MetaMask (or Rabby) on Arbitrum Sepolia with a little testnet ETH; in the app's top bar, **Get tUSD**.
4. **Tabs:**
   1. https://notes.markets (landing)
   2. https://notes.markets/app (marketplace)
   3. The in-flight note's page
   4. https://notes.markets/app/issue
   5. Terminal: `pm2 logs sn-arb-keeper --lines 0`

## The talk

**0:00 Why notes (30 s).** Tab 1, the "Why structured notes" section: yield, capital protection, exposure, hedging.
"Banks sell these with a calculation agent and a paying agent. Here the contract is the note and Chainlink CRE is
the agent."

**0:30 Why Arbitrum (20 s).** "Robinhood Chain, built on Arbitrum, has the stocks; Chainlink prices them on Arbitrum
One. So notes on Tesla or NVIDIA belong here."

**0:50 Marketplace and subscribe (50 s).** Tab 2, then tab 3: underlyings and feeds, the schedule, the workflow with
its current step lit. Subscribe 100 units and approve in the wallet: one transaction, tUSD for units.

**1:40 Issue (60 s).** Tab 4: open **12M Worst-of Phoenix on TSLA, NVDA** under Published templates: the BPMN
canvas, a gateway's condition in Properties, Validate. Issue stage: network Robinhood Chain testnet, strike in 5
minutes, observations every 3 minutes, the reserve. Publish only if time allows (approvals).

**2:40 CRE fixes the strikes (50 s).** Tab 5: `… Task_FixStrike [ETH, BTC] -> written 0x…`. Back on tab 3, without
refreshing: strikes set, book closed, the highlight on observation 1. "Every report came through Chainlink's
forwarder; the page shows it as reported by Chainlink CRE."

**3:30 Close (30 s).** "One contract runs every note as a workflow on Arbitrum and Robinhood Chain; one CRE workflow
observes and pays them all, on stocks and crypto."

## If something goes wrong

- **Strike not written yet:** CRE reads feeds at a finalized block; a report lands a minute or two after its time.
- **Equity prices look stale:** outside NYSE hours the feeds hold the last close; that's expected.
- **Faucet says already claimed:** one claim per token per hour per wallet; switch to another wallet.
- **API unreachable:** `pm2 logs sn-arb-api` and `pm2 logs sn-arb-tunnel`.
