# StratosNotes platform: production plan

A production build of StratosNotes. It keeps the hackathon's behaviour: issue a structured note from a template,
a term sheet, the AI or a BPMN canvas, sell it on a marketplace, and let Chainlink act as calculation and paying
agent. It runs on **Robinhood Chain**, **HyperEVM** and **Canton**. Solana stays in the hackathon repo
(adappterxyz/StratosNotes) and is not part of this build.

Decisions (2026-10-10):
- **New repo**, copying proven code from StratosNotes and Flow.
- **EVM and Canton only.**
- **Real stablecoins**: native USDC on HyperEVM, USDG on Robinhood Chain, USDCx on Canton. On testnets, use their
  test versions where they exist and a mock otherwise.
- **On Canton, a note's Daml is generated and compiled on demand when the note is created.**

## Chain facts this plan rests on (checked 2026-10-10)

| | HyperEVM | Robinhood Chain | Canton |
|---|---|---|---|
| Networks | testnet 998, mainnet 999 | testnet 46630, mainnet 4663 (Arbitrum chain) | DevNet / TestNet / MainNet (validator needed) |
| CRE | testnet + mainnet (forwarder `0x76c9…5E62` / `0x9eF6…784d`) | **testnet only** (forwarder `0x8E6E…AF19`) | none native: CRE drives it over HTTP (JSON Ledger API v2) |
| Feeds | mainnet BTC, ETH, SOL, HYPE; testnet none | mainnet ETH, BTC, 33 equities (24 h heartbeat); testnet none | Data Streams incl. equities |
| CCIP | ↔ Robinhood, Sepolia, Solana | ↔ HyperEVM, Sepolia, Solana | ↔ Ethereum, Base only |
| Stablecoin | Circle USDC (CCTP V2) | USDG (mainnet) | USDCx (CIP-56) |
| Quirks | 3M-gas small blocks: deploying the engine needs big-block mode | — | IP allowlist by a sponsoring SV; DAR upload per note |

Consequences:
- Prices come from Chainlink feeds wherever CRE can read them. On testnets that is Ethereum mainnet, as in the
  hackathon; for equities it is Robinhood mainnet feeds.
- **Robinhood mainnet has no CRE yet.** Production there needs a fallback keeper (the same core logic, run as a
  signed service and marked as such on the note) or has to wait for CRE support.
- **Canton is a separate island for cross-chain.** Its CCIP lanes reach only Ethereum and Base. Cross-chain
  subscription between the two EVM chains uses CCIP, and Canton notes stay on Canton.

## Architecture

```
packages/
  core/          BPMN parse/build, IR, validator, expression language, products + reference payoff,
                 templates, AI pipeline, chain-neutral compiled definition (from StratosNotes packages/flow)
  evm-engine/    Foundry: FlowEngine.sol (interprets the compiled definition: tokens, gateways, timers,
                 roles, holdings ledger, ERC-20 vaults, DvP, distribute, transfers), CRE receiver
                 (IReceiver.onReport via KeystoneForwarder), CCIP sender/receiver; tests replay every product
                 against the reference payoff
  canton/        Daml generation per note (from Flow's generate-daml: token-multiset state machine, CIP-56
                 asset ops, oracle fields), on-demand compile + DAR upload via the compiler service,
                 JSON Ledger API v2 client
  sdk/           ChainAdapter interface + EvmAdapter (viem) + CantonAdapter: issue, subscribe, transfer,
                 withdraw, read notes/holdings/history — the only thing the app and services talk to
services/
  api/           Cloudflare Worker: REST for the app, auth (wallet sign-in, Canton party), templates, AI,
                 faucet (testnets), compile-on-demand for Canton
  indexer/       per-chain event ingestion into one read model (D1/Postgres): notes, holdings, events,
                 payouts; the marketplace and note pages read this, live via WebSocket/SSE
  keeper-cre/    CRE workflows: EVM (read feeds, writeReport to the forwarder per chain) and Canton
                 (HTTP to the ledger through a relay with the paying agent's party token)
  keeper-fallback/  the same keeper core as a signed service, for chains without CRE (Robinhood mainnet)
app/             React app (Marketplace · Issue · Portfolio), chain-neutral via sdk; EVM wallets
                 (wagmi/RainbowKit), Canton party login; landing page
```

Invariants carried over from the hackathon and Flow:
- **One compiled workflow per note design.** EVM runs it in a generic engine. Canton compiles it to Daml for that
  note. Both must match the reference payoff, which is tested per product on every chain.
- **Oracle values are bounds-checked on-chain** and accepted only from the CRE forwarder (EVM) or the paying-agent
  party (Canton).
- **The engine holds note units and payouts in its own ledger.** Holders withdraw, or a payout is sent over CCIP.

## Phases

| # | Phase | Ships | Exit check |
|---|---|---|---|
| 1 ✅ (testnet deploy deferred) | **EVM engine** | core package; FlowEngine.sol + tests (all 5 products, worst-of, physical delivery, custom workflows) vs reference payoff; deploys to HyperEVM testnet and Robinhood testnet | Foundry tests green; one note run end to end on each testnet |
| 2 ✅ (forks) | **CRE on EVM** | keeper-cre EVM workflow (feeds → writeReport per chain); fallback keeper | `cre workflow simulate --broadcast` drives a note's whole life on both testnets. Done on anvil forks of both testnets (scripts/e2e-cre-evm.sh); real testnets deferred (no broadcasting to real networks for now) |
| 3 ✅ (local fork) | **App + API + indexer** | sdk ChainAdapter/EvmAdapter; indexer (Postgres, reorg-safe); API (Hono: notes, portfolio, templates, AI, SSE); app ported (wagmi + RainbowKit, marketplace across chains) | the hackathon demo script runs on both EVM testnets. Done on a HyperEVM testnet fork: `E2E=1 bash scripts/dev-local.sh` issues from the app, two investors subscribe, the keeper (fallback or CRE simulator) runs it to redemption, payouts match the reference; real testnets deferred |
| 4 ✅ (local sandbox; DevNet deferred) | **Canton** | per-note Daml compiled on demand from the same compiled definition (packages/canton), open Offering book, CIP-56 settlement (USDCx stand-in), Position statements per holder, CantonAdapter (sdk ChainAdapter), ledger relay (paying agent service + CRE endpoints), CRE keeper for Canton, indexer Canton source, API + app (proven-party sign-in, issue/subscribe/transfer/payout) | a note issued, subscribed and run to redemption on Canton DevNet. Done on a local sandbox: `bash scripts/canton-product-runs.sh` 13/13 match the reference; `E2E=1 bash scripts/dev-local-canton.sh` issues from the app, two investors subscribe, Chainlink CRE (simulator, through the relay) or the fallback runs the note to redemption, payouts match the reference. DevNet: docs/canton-devnet-runbook.md (credentials, parties, vetting, USDCx, relay, CRE staging) |
| 5 | **Cross-chain** | CCIP subscribe/payout between HyperEVM and Robinhood (USDC lanes or our pools) | Robinhood investor in a HyperEVM note, paid automatically |
| 6 | **Production hardening** | issuer/investor onboarding + allowlists, key management (KMS/multisig for admin + paying agent), monitoring/alerts, rate limits, contract audit, mainnet deploy | audit findings closed; runbooks; mainnet notes on HyperEVM (+ Robinhood when CRE lands) |

## Needed from outside this repo

- Testnet gas: HyperEVM testnet HYPE (the official faucet requires a mainnet deposit; QuickNode faucet otherwise)
  and Robinhood testnet ETH (faucet.testnet.chain.robinhood.com).
- A Canton DevNet validator to use (Stratos's), and the paying-agent party.
- CRE: the existing account; deploy access for production workflows.
- A GitHub repo for this code.
