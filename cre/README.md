# CRE: the calculation agent

`notes-keeper-evm` is one Chainlink CRE workflow (TypeScript, `@chainlink/cre-sdk` 1.23). It is the
calculation agent for every note on every configured EVM chain.

Each cron run does this for each chain in the config:

1. **Read the notes.** One `NotesLens.running` call at the last finalized block returns every running
   process. Each distinct definition's full bytes (`NotesLens.definitionBytes`) supply its oracle feeds.
2. **Decide what is due.** The shared logic in `packages/core/src/keeper.ts` picks strike fixings and
   observations whose date has come, plus plain timers to advance.
3. **Read prices.** Each due oracle step reads the Chainlink feed of every underlying it captures, on the
   chain that feed lives on, at a finalized block. A round older than the feed's heartbeat plus
   `finalityAllowanceSec` is refused.
4. **Write a report.** It sends `abi.encode(uint256 pid, uint16 step, int256[] values)` with `writeReport`
   to the chain's FlowEngine, through the KeystoneForwarder. The engine bounds-checks every value, then runs
   the step and everything that follows (coupons, autocall, redemption) in the same transaction.

| Target | Chains written | Feeds read | Forwarder |
|---|---|---|---|
| `local-fork` | an anvil fork of Arbitrum Sepolia (`SN_FORK_PORT`) | Ethereum mainnet (crypto), Arbitrum One (equities) | MockKeystoneForwarder (`--broadcast`) |
| `staging-settings` | Arbitrum Sepolia, Robinhood Chain testnet | Ethereum mainnet (crypto), Arbitrum One (equities): the testnets have no feeds | MockKeystoneForwarder (`--broadcast`) or KeystoneForwarder once deployed |
| `production-settings` | Arbitrum One | Ethereum mainnet and Arbitrum One | KeystoneForwarder |

Equity feeds (TSLA, NVDA, AAPL, SPY on Arbitrum One) follow NYSE hours with a 24 h heartbeat; the products set
a 4-day staleness allowance for them so a weekend doesn't block an observation. A note observed on a Monday
morning before the open uses Friday's close.

CRE has no Robinhood Chain **mainnet** support yet. Notes there are run by `services/keeper-fallback`.

## Config

Generate a target's config from `deployments/<chain>.json`:

```bash
npx tsx scripts/cre-config.ts staging
```

A chain that isn't deployed gets the zero address, and the workflow refuses to start with it.

| Field | Meaning |
|---|---|
| `chains[].gasLimit` | Gas for one report (6M). A coupon to a full book of 62 holders measured 2.33M of execution and a default distributing three escrow assets to 62 holders 4.79M; the rest covers Arbitrum's L1 data gas. CRE allows 10M per write. |
| `chains[].fromPid` | First process id to scan, to skip finished history. |
| `chains[].scan` | How many process ids one lens call reads. |
| `chains[].maxProcesses` | How many running processes one lens call returns. Up to 4 pages per run. |
| `maxReportsPerRun` | Writes per run, across all chains. |
| `finalityAllowanceSec` | Extra staleness allowed for reads at a finalized block. |
| `feedRoutes` | Optional. Sends a recorded feed (lowercase address) to another source. |

## Run

From this directory (CLI logged in):

```bash
cre workflow simulate notes-keeper-evm --target staging-settings --non-interactive --trigger-index 0              # dry run
cre workflow simulate notes-keeper-evm --target staging-settings --non-interactive --trigger-index 0 --broadcast  # writes
```

- **Broadcasting** needs `CRE_ETH_PRIVATE_KEY`. `scripts/keeper-loop.sh` passes the keeper key
  (`.keys/keeper.json`) in a temporary env file it deletes after each run. That key pays gas on each written
  chain.
- **Deploying** (`cre workflow deploy`) needs CRE deploy access, a linked funded wallet, and engines whose
  forwarder is the KeystoneForwarder (`FORWARDER_MODE=production` in `packages/evm-engine/script/Deploy.s.sol`).

The full life of a note on an Arbitrum Sepolia fork, driven by the simulator: `bash scripts/e2e-cre-evm.sh`.
