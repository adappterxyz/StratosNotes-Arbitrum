# notes.markets: milestone plan

Prizes pay 50% upfront and 50% on milestones. This plan covers about six months from Founder House (late October
2026). Targets in `[[…]]` are for the team to set.

## Where we start (October 2026)

- Live on **Robinhood Chain testnet** and **Arbitrum Sepolia**: notes.markets (landing and app), the API, and the
  Chainlink CRE keeper.
- Two notes ran start to finish on testnet, with every strike, observation and payment written by Chainlink CRE:
  TSLA/NVDA on Robinhood paid 630 and 420 tUSD; ETH/BTC on Arbitrum Sepolia paid 645 and 430 tUSD
  ([SUBMISSION.md](SUBMISSION.md#evidence)).
- Engine v2: collateral escrow, per-period funding with a grace period, default to holders, and a verified email
  bound on-chain as a salted hash.
- 128 unit tests and 26 contract tests passing.

## M1: Secure and mainnet-ready on Arbitrum One (month 1–2)

| | |
|---|---|
| Deliverables | Independent audit of the engine and its libraries, with all high and medium findings fixed. Fuzz and invariant tests in CI. Deployment on **Arbitrum One** with real USDC as the cash asset. Chainlink CRE deployed to the DON (production forwarder), not the simulator. Engine owner and verifier keys moved to a multisig and KMS. |
| Acceptance | Audit report published. One note issued on Arbitrum One with USDC, observed by production CRE, run to redemption, with payouts equal to the reference payoff. |
| Dependencies | Audit firm `[[auditor, date]]`; CRE deploy access from Chainlink; audit budget `[[cost]]`. |

## M2: Robinhood Chain mainnet with stock tokens (month 2–3)

| | |
|---|---|
| Deliverables | Deployment on **Robinhood Chain mainnet**. Notes on real Robinhood stock tokens (delivery and collateral) and USDG or USDC as cash. Equity prices from Chainlink feeds. CRE where supported; the fallback keeper (labelled on every report) until CRE supports Robinhood mainnet. |
| Acceptance | `[[n]]` notes on TSLA/NVDA/AAPL/SPY issued on Robinhood Chain mainnet and observed on schedule. |
| Dependencies | CRE support for Robinhood mainnet (or approval to run the fallback keeper); Robinhood Chain stock-token access. |

## M3: First real issuers (month 3–5)

| | |
|---|---|
| Deliverables | Onboard `[[n]]` issuers (treasuries, market makers, funds). Issue `[[n]]` notes with `[[$ notional]]` total. A template library from real issuances. Email alerts in production. An issuance fee or servicing fee switched on. |
| Acceptance | `[[n]]` notes issued by `[[n]]` distinct issuers; `[[%]]` of payments funded on time; `[[n]]` repeat issuers. |
| Dependencies | Issuer pipeline `[[names]]`; pricing decision (see [GTM-CANVAS.md](GTM-CANVAS.md)). |

## M4: Compliance layer and distribution (month 5–6)

| | |
|---|---|
| Deliverables | Allowlists per note (issuer-chosen investor sets). A KYC partner integration for eligible investors. Legal review for `[[jurisdictions]]`. `[[n]]` distribution partners (wallets, fintechs or brokers) offering a notes shelf. |
| Acceptance | Allowlisted notes live; `[[n]]` partner integrations in production; `[[n]]` investors onboarded through partners. |
| Dependencies | KYC provider `[[name]]`; legal counsel `[[name]]`; partner agreements. |

## Use of funds

`[[Split of the prize/grant across audit, engineering, compliance and BD]]`

## Placeholders to fill

`[[auditor, date]]`, `[[cost]]`, `[[n]]` (several), `[[$ notional]]`, `[[%]]`, `[[names]]` (issuer pipeline),
`[[jurisdictions]]`, `[[name]]` (KYC provider, counsel), use of funds.
