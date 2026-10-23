# notes.markets: Product and GTM canvas

A working canvas for Arbitrum Founder House. Everything marked `[[…]]` is for the team to fill in; nothing here is a
claim about users or revenue we don't have yet.

## 1. Problem

- **Investors** want defined outcomes on stocks and crypto: income while prices stay in a range, their money back with
  some upside, exposure to a basket on set terms, or a hedge on what they hold. Structured notes do this, but today
  they are bank products: sold to wealth clients where the bank sells them, with a calculation agent the investor has
  to trust to decide every payout.
- **Issuers** (anyone with a balance sheet and a market view) can't easily raise funding this way. Creating a note
  takes weeks of structuring and legal work, a paying agent and a distribution channel.
- **On-chain**, yield products are mostly vaults running rolling strategies. Few have a fixed term sheet, a schedule
  agreed in advance, an independent calculation agent and enforceable collateral.

## 2. Customer segments

| Segment | Side | Why they'd use it | Reachable now? |
|---|---|---|---|
| Protocol treasuries, market makers, crypto funds | Issuer | Raise stablecoins against collateral they already hold, on terms they set, paying per period instead of up front | Yes: on-chain natives, Arbitrum ecosystem |
| Crypto-native funds and DAOs with idle stablecoins | Investor | Defined-outcome yield or hedges on ETH/BTC and tokenized stocks, with collateral behind every payment | Yes |
| Fintechs and brokers wanting a note shelf | Issuer / distributor | White-label issuance on a template, with Chainlink as calculation agent | Later: needs BD and compliance |
| Retail on Robinhood Chain | Investor | Notes on the stocks they already hold or follow (TSLA, NVDA, AAPL, SPY) | Long term: needs the compliance layer (see risks) |

**Beachhead:** crypto-native issuers (treasuries, market makers, funds) selling to crypto-native investors, on
Robinhood Chain and Arbitrum. Reasons:
- Both sides are already on-chain and hold the collateral and stablecoins the product needs.
- They can use the product without a retail distribution licence, which retail notes would need (see risks).
- Notes on tokenized stocks are where Robinhood Chain is different from every other chain, and a crypto-native fund
  is the most likely first buyer of one.

Retail on Robinhood Chain is the larger, longer-term audience, reached through a distribution partner once the
compliance layer exists. `[[BEACHHEAD: confirm, name 3–5 target issuers]]`

## 3. Jobs to be done

**Issuer**
- Raise stablecoins now against assets I hold, without selling them.
- Express a market view I'm confident in and get paid for taking the other side.
- Offer my clients a defined-outcome product without building a structuring desk.

**Investor**
- Earn a known income while a stock or coin stays in a range.
- Keep my capital with some upside.
- Get exposure to a stock or basket on defined terms.
- Hedge a position I hold.
- Know that someone other than the issuer decides the payouts, and that collateral backs them.

## 4. Value proposition

| Investor | Issuer |
|---|---|
| A result agreed before you buy, written into the contract | Funding today: subscription money is yours at once |
| Chainlink CRE fixes every price; the contract pays automatically | No paying agent or calculation agent to hire: the engine and Chainlink do both |
| Collateral locked in the note, margin-checked at every observation; if the issuer misses a payment, holders take it (up to what they're owed) | Pay as you go: fund each coupon when it falls due, with a 0–7 day grace period you set |
| Email alerts on every payment and any default | Issue from a template in minutes; design your own on a BPMN canvas or with the AI |
| Transfer units, withdraw payouts any time | Your terms: collateral assets, haircuts, ratio, settlement lag |

## 5. Unfair advantage

- **The engine runs any note as a workflow.** Notes are BPMN workflows compiled to one on-chain engine, so a new
  product is a template, not a new audited contract. The same engine ran the Solana build (TOKEN2049, won Chainlink's
  CRE track) and now runs on Arbitrum. The workflow tooling comes from StratosFlow, our BPMN workflow builder.
- **Chainlink CRE is the calculation agent.** It writes every strike and observation through Chainlink's forwarder.
  Each report is labelled on the note (CRE or fallback keeper).
- **Payments are enforced, not promised:** escrowed collateral, funding deadlines, grace and default are all steps
  the contract runs.
- **Stocks are the differentiator.** We read Chainlink's TSLA/NVDA/AAPL/SPY feeds on Arbitrum One, so notes on stocks
  work today.

## 6. Channels

1. **Robinhood Chain ecosystem:** launch-partner programme, builder community, co-marketing for notes on stock
   tokens.
2. **Arbitrum DeFi:** list note units and integrate with lending, wallets and portfolio dashboards. Issuers who
   already hold collateral on Arbitrum.
3. **Direct issuer BD:** treasuries, market makers and funds; the first notes are issued with us.
4. **Wallet and fintech partners:** a note shelf inside their apps (later).
5. **Content:** the note explorer on notes.markets shows what a note does along any price path, for investors and
   issuers. Public templates and worked examples.

## 7. Revenue model (options; levels to decide)

| Option | How | Already supported? |
|---|---|---|
| Issuance fee | `[[bps]]` of notional at issue | Needs a fee step at issuance |
| Servicing fee | Per-period fee paid by the issuer with each coupon | Yes: the servicing-fee template has a paying-agent fee step |
| Template marketplace | Template authors earn a share of issuance on their templates | Templates are signed by their author today; payment isn't built yet |
| Distribution share | Revenue share with distribution partners | Commercial terms only |

`[[PRICING: levels and which option first]]`

## 8. Key metrics

- Notes issued, and notional issued (per chain).
- Subscribers per note; repeat subscribers.
- Repeat issuers (second note within `[[n]]` days).
- Time from opening the app to issuing a note.
- Share of payments funded on time; defaults and their recovery per unit.
- CRE report success rate; share of reports by fallback keeper.
- `[[TARGETS: per metric, per milestone]]`

## 9. Cost structure

- Engineering and maintenance (the team).
- Security: audits of the engine and libraries before mainnet, and again after any engine change.
- Chain gas: deployments, plus CRE report writes (measured 0.3–0.5M gas per report; up to about 5M for a default to 62
  holders).
- Chainlink CRE: production workflow costs once deployed to the DON `[[CRE pricing]]`.
- Cloudflare: Workers Paid (site, API, D1, cron, email).
- Compliance: KYC/allowlist provider and legal opinions per market `[[budget]]`.

## 10. Risks and regulation (candid)

- **Securities law.** In most jurisdictions structured notes sold to retail are securities. A retail launch needs a
  licensed distributor, KYC and per-market legal review. Until then we target professional/crypto-native participants
  and keep a compliance layer (allowlists, KYC partner) on the roadmap. `[[LEGAL: jurisdictions, counsel]]`
- **Issuer credit risk.** Collateral is capped at what the issuer pledges and the ratio they set. A note with 20%
  collateral can still lose holders money in a default. The app shows the ratio and coverage prominently; issuer
  reputation and minimum ratios may be needed.
- **Oracle and keeper risk.** Prices come from Chainlink feeds, and CRE runs today in Chainlink's simulator, writing
  real testnet transactions. Production needs CRE deploy access. CRE doesn't support Robinhood mainnet yet; a
  fallback keeper covers it and every report says which acted.
- **Smart-contract risk.** The engine has not been audited. It is at 24,351 of 24,576 bytes, so new features need
  code moved into libraries.
- **Test assets.** Notes use our test tokens (tUSD, tTSLA…), not real stablecoins or stock tokens.

## 11. Assumptions to test

1. Crypto-native issuers will pledge collateral to raise funding through notes, rather than borrow on a lending
   market. `[[test: interviews with n issuers]]`
2. Investors value a fixed term sheet and enforced collateral over a vault's variable yield.
3. Notes on tokenized stocks attract Robinhood Chain users more than crypto-only notes.
4. A 0–7 day grace period and the cap-at-owed default rule feel fair to both sides.
5. Template-based issuance takes under `[[x]]` minutes for a first-time issuer.
6. Email alerts (payment due, paid, default) measurably improve on-time funding.

## Placeholders to fill

`[[BEACHHEAD]]`, `[[bps]]`, `[[PRICING]]`, `[[n]]` (repeat window), `[[TARGETS]]`, `[[CRE pricing]]`, `[[budget]]`
(compliance), `[[LEGAL]]`, `[[test: interviews]]`, `[[x]]` (minutes to issue).
