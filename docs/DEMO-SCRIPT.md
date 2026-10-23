# notes.markets: 2-minute demo script

For recording the demo video, and for a live pitch. URLs are live on Robinhood Chain testnet and Arbitrum Sepolia.

## Before you start

- **Wallet:** a browser wallet on **Robinhood Chain testnet** (chain 46630) with a little test ETH
  (faucet.testnet.chain.robinhood.com). A second account to play the investor.
- **Tokens:** in the app, use the faucet button to claim **tUSD**, both for collateral and to subscribe.
- **Email:** an inbox you can read during the demo; the 6-digit code arrives there.
- **Tabs, in order:**
  1. https://notes.markets
  2. https://notes.markets/#explore
  3. https://notes.markets/app/issue
  4. https://notes.markets/app/note/robinhood-testnet:0xa1c0a6c72d07d885e2b91ecad4aabe758f446c35:1 (open TSLA/NVDA
     note, v2 engine; the book is open until 25 Oct 2026, 13:29 UTC)
  5. https://notes.markets/#proof
  6. The Robinhood explorer link for the strike report:
     https://explorer.testnet.chain.robinhood.com/tx/0x77e678a32a097b58818f7df64fc50204fe714cb4caaac392dd267c61bdcc196d

## Script

| Time | Screen | Say |
|---|---|---|
| 0:00 | Tab 1, hero | "A structured note is an agreement made before you buy: what you're paid, and when, depending on a price. Today only banks issue them. notes.markets lets anyone issue one on-chain, with Chainlink as the calculation agent." |
| 0:12 | Scroll to the carousel; turn it once | "For investors: income in a range, capital back with upside, exposure to stocks, a hedge. For issuers: raise funding against collateral and pay as you go." |
| 0:25 | Tab 2, explorer: investor side, phoenix on TSLA/NVDA, preset **Choppy** | "Pick a note, shape the market, and see exactly what you'd be paid. This is the same reference payoff the contract is tested against." |
| 0:38 | Switch to **I want to issue**; turn on **What if I miss a payment?** | "As the issuer you raise money now, pledge collateral, and fund each coupon when it's due. Miss one, and after the grace period the holders take the collateral, capped at what they're owed." |
| 0:52 | Tab 3, Issue: open the **TSLA/NVDA worst-of phoenix** template; show the BPMN canvas and its funding steps | "Every note is a workflow. Each payment has a funding step, a deadline and a default branch; the validator won't let you publish a note that pays without being funded." |
| 1:05 | Issue stage: size, dates, collateral ratio; click Issue; enter the email and code | "To issue you verify your email. It's bound on-chain as a salted hash, so the contract can require it without anyone seeing it. Then collateral goes into the note's escrow." |
| 1:20 | Tab 4, switch to the investor account; **Subscribe** 100 units | "Investors buy units for stablecoins in one transaction. The money goes to the issuer as funding. Every payment date, they get an email." |
| 1:35 | Tab 5, Proof: the TSLA/NVDA run; open tab 6 | "Here's a note that ran to the end on Robinhood Chain testnet: Chainlink CRE fixed the strike, observed, the issuer funded each payment, and holders were paid 630 and 420, exactly the reference payoff." |
| 1:50 | Back to tab 1, "Built on" row | "Why Robinhood Chain: the stocks and their Chainlink prices are on one chain. Next: audit, Arbitrum One with real USDC, then Robinhood mainnet with real stock tokens." |
| 2:00 | End | |

## Fallbacks

- **Wallet or faucet is slow:** skip the live issue and subscribe. Show tab 4 (the open note: collateral, funding
  schedule, book) and say what the buttons do.
- **Email code is slow:** show the dialog. Say: "the code arrives by email; the contract won't let an unverified
  address issue or subscribe."
- **Site is down:** play the recorded video. Show the proof transactions directly on
  https://explorer.testnet.chain.robinhood.com and https://sepolia.arbiscan.io (links in
  [SUBMISSION.md](SUBMISSION.md#evidence)).
- **Asked about CRE live:** the keeper log on the server shows `Task_FixStrike … -> written 0x…` lines
  (`pm2 logs sn-arb-keeper`).

## Shots to capture for the video

1. The hero and the carousel turning (desktop).
2. The explorer: investor view, then issuer view with a missed payment.
3. The canvas showing Fund Payment → Funded? → Pay / Grace → Default.
4. The email verification dialog and the email in the inbox.
5. The note page after subscribing: holders, collateral coverage, payment schedule.
6. The proof table and one explorer transaction (`Report` → `onReport`).
