# StratosNotes on Arbitrum

Structured notes on stocks and crypto that anyone can issue and sell, on **Arbitrum Sepolia** and **Robinhood Chain
testnet**, with **Chainlink CRE** as the calculation agent. A note raises funds for the issuer against collateral
locked in the note; the issuer funds each payment before it falls due, or the collateral goes to the holders
([docs/NOTE-ECONOMICS.md](docs/NOTE-ECONOMICS.md)). Built for the Arbitrum Hackerhouse.

- Site: https://notes.stratoslab.app · App: https://notes.stratoslab.app/app
- Submission: [docs/SUBMISSION.md](docs/SUBMISSION.md) · Demo: [docs/DEMO.md](docs/DEMO.md) · Deploy: [docs/DEPLOY.md](docs/DEPLOY.md)

| Path | What it is |
|---|---|
| `packages/core` | BPMN, compiler (EVM definition bytes), products and reference payoffs, templates, AI pipeline, keeper decisions |
| `packages/evm-engine` | `FlowEngine.sol`, `NotesLens.sol`, test tokens and faucet, Foundry tests, deploy script |
| `packages/sdk` | chain adapter (viem), events and the read model |
| `cre/notes-keeper-evm` | the Chainlink CRE workflow |
| `services/indexer`, `services/api` | Postgres read model and the REST/SSE API |
| `services/keeper-fallback` | the same keeper logic for chains without CRE (off by default) |
| `scripts/issuer-bot.ts` | the issuer's side, automated for demos and tests: funds payments as they fall due (or leaves one unfunded) |
| `app`, `landing`, `web` | the app, the landing page, and the Cloudflare Worker that serves both |

```bash
npm install && npm run typecheck && npm test        # unit tests
npm run test:evm                                    # Foundry (fetch lib/ first: packages/evm-engine/README.md)
bash scripts/e2e-cre-evm.sh                         # CRE simulator + fallback keeper on local testnet forks
E2E=1 bash scripts/dev-local.sh                     # the whole stack locally, driven by a headless browser
```
