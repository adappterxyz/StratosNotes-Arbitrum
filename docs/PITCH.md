# notes.markets: 3-minute pitch

## Narrative

**Problem (0:00–0:30).** A structured note is a promise about dates and prices: "every quarter, if Tesla and NVIDIA
both hold 70% of today's price, you get 3%; if both are up, you get your money back early." Investors use notes for
income, protection, exposure and hedging. But only banks can issue them. Each one takes weeks of structuring, a
calculation agent you have to trust and a paying agent, and you can only buy where the bank sells.

**Why it matters (0:30–0:50).** Issuers with a balance sheet and a view (treasuries, market makers, funds) have no
simple way to raise money this way. Investors on-chain get vaults with variable yields, not a term sheet with a
schedule and an independent price check. Robinhood Chain puts tokenized stocks and their prices on-chain, so the
missing piece is the note itself.

**Solution (0:50–1:20).** notes.markets turns a note into a workflow the contract runs:
- The issuer pledges collateral, locked in the note, and raises stablecoins from investors.
- Chainlink CRE fixes the strike, observes every date and checks the collateral still covers the note.
- The issuer funds each coupon by the payment date, plus a grace period of up to seven days. If they don't, the note
  defaults and holders take the collateral, up to what they're owed.
- Anyone can issue from a template, a term sheet, a sentence to the AI, or by drawing the workflow on a BPMN canvas.

**Demo (1:20–2:10).** Follow [DEMO-SCRIPT.md](DEMO-SCRIPT.md) 0:25–1:50 in short form:
1. The explorer, investor then issuer view.
2. Issue from the TSLA/NVDA template with email verification.
3. Subscribe.
4. The completed note on Robinhood Chain testnet that paid exactly the reference payoff.

**Business (2:10–2:30).** Revenue options are an issuance fee in basis points, a per-period servicing fee (already a
template step), and a template marketplace. The first customers are crypto-native issuers selling to crypto-native
investors; retail comes later through a licensed distribution partner. `[[PRICING]]`

**Why us (2:30–2:45).**
- We built StratosFlow, a BPMN workflow builder, and narrowed it to structured notes at TOKEN2049, where we won
  Chainlink's CRE track.
- In the weeks since, we rebuilt it on Arbitrum with collateral, funding calls, default handling and email
  verification on-chain.
- `[[TEAM: names, roles, relevant background]]`

**Milestones and ask (2:45–3:00).**
- **Milestones:** audit and hardening; stock notes on Robinhood Chain testnet with its own stock tokens; first
  issuers; a compliance layer and distribution partners. Mainnet follows once Chainlink CRE production access and
  the audit are in place ([MILESTONES.md](MILESTONES.md)).
- **Ask:** `[[ASK: prize/grant amount and what it funds]]`, plus introductions to the Robinhood Chain team and to
  issuers.

## Likely questions

**Aren't these securities?**
In most places, yes, when sold to retail. We start with professional and crypto-native participants, and the
roadmap adds per-note allowlists, a KYC partner and legal review per market before any retail launch. We don't claim
the testnet product is cleared for retail. `[[LEGAL]]`

**Why trust the oracle?**
Prices come from Chainlink feeds, written by a Chainlink CRE workflow through Chainlink's forwarder. The contract only
accepts reports from the forwarder and bounds-checks every value. Each report on a note shows whether CRE or our
fallback keeper made it. Today CRE runs in Chainlink's simulator writing real testnet transactions; production needs
CRE deploy access (milestone 1). CRE doesn't support Robinhood mainnet yet.

**What if the issuer defaults?**
The collateral is locked in the note and priced by Chainlink at every observation; a shortfall triggers a margin
call. A missed payment, after the grace period, sends the collateral to holders pro rata, up to what they're owed,
with the rest returned to the issuer. Holders are only as protected as the collateral ratio, which the issuer sets
and the app shows prominently.

**Why on-chain?**
The schedule, the collateral and the enforcement are code that anyone can check, instead of promises from a
calculation agent and a paying agent. Settlement is instant, units are transferable, and a new product is a template,
not a new legal and operations process.

**How is this different from options vaults or RWA platforms?**
- **Options vaults** run rolling strategies with variable outcomes. A note has a fixed term sheet, a schedule and a
  payoff agreed upfront.
- **RWA platforms** mostly tokenize existing off-chain assets. Here the note is created and serviced on-chain,
  with collateral enforcement and Chainlink as calculation agent.

We don't name specific competitors without data.

**Is the contract audited?**
Not yet; that is milestone 1. Today: custom errors, reentrancy guards, safe ERC-20 transfers, two-step ownership,
every product checked against a reference payoff, and attestation tests (replay, expiry, revocation). The engine is
near the 24 KB size limit, so new logic goes into libraries.

**Why Robinhood Chain and not just Arbitrum One?**
Notes on stocks need the stocks and their prices together. Robinhood Chain has tokenized stocks, and Chainlink
publishes equity feeds. We fix each stock on Robinhood Chain's own Chainlink feeds (and crypto on Ethereum's). Deploying to Arbitrum One itself, for crypto notes and
DeFi liquidity, comes with mainnet, after production CRE access and an audit; until then we stay on testnets.

## Placeholders to fill

`[[PRICING]]`, `[[TEAM]]`, `[[ASK]]`, `[[LEGAL]]`.
