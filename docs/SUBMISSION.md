# StratosNotes on Arbitrum: Arbitrum Hackerhouse submission

**One line:** structured notes on stocks and crypto that anyone can issue, from a template, a term sheet, a sentence
to the AI or a BPMN canvas, sold for stablecoins on Arbitrum Sepolia and Robinhood Chain testnet, with Chainlink CRE
as the calculation and paying agent.

- Site: https://notes.markets · App: https://notes.markets/app
- Code: https://github.com/adappterxyz/StratosNotes-Arbitrum
- Demo script: [DEMO.md](DEMO.md) · Runbook: [DEPLOY.md](DEPLOY.md)
- Earlier build (Solana, TOKEN2049, won Chainlink's CRE track): https://sp.stratoslab.app

## Tracks

| Track | What we built for it |
|---|---|
| **Arbitrum** | `FlowEngine.sol` runs compiled BPMN workflows on-chain: a token-multiset state machine with gateways on price predicates (`min`/`max` for worst-of baskets), parallel fork/join, timers on per-issuance dates, open roles, repeatable subscription windows, an internal holdings ledger with atomic stablecoin-for-units DvP, distribute-to-every-holder (cash or a delivered token), transfers in whole or in part, and withdrawals. One contract runs every product; each issuance is a process of a content-addressed definition. Deployed to Arbitrum Sepolia and Robinhood Chain testnet (Robinhood's chain on the Arbitrum stack, made for tokenized stocks). |
| **Chainlink CRE** | `cre/notes-keeper-evm`: one CRE workflow is the calculation agent for every note on both chains. Each run reads every running note through `NotesLens` at a finalized block, decides which strikes and observations are due, reads the Chainlink feeds (crypto on Ethereum mainnet, **TSLA/NVDA/AAPL/SPY on Arbitrum One**) at a finalized block with staleness checks, and writes signed reports through each chain's forwarder. The engine accepts reports only from the forwarder, bounds-checks every value, and runs coupons, autocalls and redemptions in the same transaction. Each report records whether CRE or a fallback keeper made it. |

## The problem

A structured note turns a market view into an outcome agreed upfront: yield while prices stay in a range, capital
protection with some upside, exposure to a stock or a basket on defined terms, or a hedge. Banks issue them with a
calculation agent and a paying agent and weeks of structuring; investors buy where the bank sells. DeFi's yield
products are mostly vaults with rolling strategies, with no fixed term sheet or independent calculation agent.

## What it does

1. **Design** (Issue workspace): a template (eight seeded, two of them on stocks), a term sheet (fixed coupon note,
   reverse convertible, phoenix with memory, snowball, principal-protected; one underlying or a worst-of basket; cash
   or physical settlement), a sentence to the AI, or a blank BPMN canvas. Every edit passes the validator and
   compiler.
2. **Issue**: this issuance's size, strike and observation dates and coupon reserve (plus a delivery reserve of the
   underlying's token for physical settlement). The book opens on the marketplace.
3. **Sell**: anyone swaps stablecoins for units in one transaction until the strike date; holders transfer units.
4. **Observe and pay**: CRE fixes the strike and observes every date; coupons, autocall, knock-in and redemption
   settle on-chain. Below a knock-in, a physical note delivers units ÷ strike of the (worst) underlying's token.

## Architecture

```
template / term sheet / AI / canvas -> BPMN -> compiler -> definition (bytes, content-addressed)
                                                                  |
                      FlowEngine on Arbitrum Sepolia and Robinhood Chain testnet (one contract, every note)
                                   ^ onReport via KeystoneForwarder
Chainlink feeds (Ethereum, Arbitrum One) -> CRE notes-keeper-evm
indexer (Postgres) -> API (Hono) -> app (wagmi) ; notes.markets = one Cloudflare Worker (landing, app, AI)
```

## Evidence

**Testnet deployment** (fill after `scripts/deploy-testnets.sh`; addresses are in `deployments/<chain>.json`):

| Network | FlowEngine | NotesLens | TokenFaucet | Forwarder |
|---|---|---|---|---|
| Arbitrum Sepolia | | | | MockKeystoneForwarder `0xD412…ca5d` |
| Robinhood Chain testnet | | | | MockKeystoneForwarder `0x0b93…3885` |

**A note run by CRE on each testnet** (fill after the seeded notes complete):

| Chain | Event | Transaction | Gas |
|---|---|---|---|
| Arbitrum Sepolia | CRE fixes the strikes (ETH, BTC) | | |
| | CRE observation 1 | | |
| | CRE observation 2: coupon, autocall, redemption | | |
| Robinhood Chain testnet | CRE fixes the strikes (TSLA, NVDA) | | |
| | … | | |

**Verified before deployment, on local forks of the real testnets** (anvil, with the chains' real
MockKeystoneForwarders; `scripts/e2e-cre-evm.sh`, 2026-10-23):

| Run | Reports (by the Arbitrum Sepolia MockKeystoneForwarder) | Payouts vs reference |
|---|---|---|
| Worst-of phoenix on ETH, BTC, CRE simulator | strike ETH 2,406.36 / BTC 81,852.64 (206k gas), observations (366k, 388k gas) | 630 and 420 for 600 and 400 units = 1.05 per unit: match |
| Worst-of phoenix on TSLA, NVDA, CRE simulator, prices from Arbitrum One | strike TSLA 374.93 / NVDA 212.54 (206k gas), observations (366k, 388k gas) | 630 and 420: match |
| Same ETH/BTC note on a Robinhood Chain testnet fork, fallback keeper | strike (160k gas), observations (320k, 342k gas), reported by the fallback reporter | 630 and 420: match |

**Tests:** Foundry 21 (13 product scenarios against the reference payoff, including worst-of and physical
delivery; access control; faucet). Unit tests: core 32, SDK 4, indexer 8 (reorgs, replay), API 9.

## Honest limits

- CRE runs in Chainlink's simulator with `--broadcast` (through the MockKeystoneForwarder) until DON deploy access;
  the engine's forwarder is admin-settable for the production KeystoneForwarder.
- Equity feeds follow NYSE hours with a 24 h heartbeat: notes accept a 4-day-old round so a weekend doesn't block
  them, and an observation outside market hours uses the last close.
- Testnet stablecoins and delivered tokens are our own test tokens (tUSD, tETH, tTSLA…) from an on-chain faucet;
  Arbitrum Sepolia also has Circle test USDC and Robinhood testnet has stock tokens, usable by configuration.
- CRE can't write to Robinhood Chain **mainnet** yet; a fallback keeper (off by default, marked on every report)
  covers it until it can.
- Up to 64 holders per note, 12 observations, 3 underlyings. No audit yet.

## What's next

`cre workflow deploy` to the DON; Arbitrum One with Circle USDC; Robinhood's own stock tokens as delivered assets;
cross-chain subscriptions over CCIP between Arbitrum and Robinhood Chain; an audit.
