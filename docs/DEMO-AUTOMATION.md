# Automating the product demo from a Windows machine

Instructions for an agent (e.g. Claude Code on Windows) that drives the presenter's own browser to record the
notes.markets product demo. **The presenter signs every MetaMask prompt themselves**; the agent only navigates,
fills and clicks the page, waits for each on-chain step and keeps the recording going. Never ask for, read or type a
seed phrase or private key.

## What the demo shows (target edit: 1:50; raw recording ~45 min)

A TSLA reverse convertible issued on **Arbitrum Sepolia** (the anchor) whose only collateral is **TSLA locked on
Robinhood Chain testnet** (it never leaves that chain). Chainlink CRE fixes the strike from Robinhood Chain's own
TSLA feed, the issuer funds two coupons, the investor claims with receipts, and when the note ends the TSLA is
released back to Robinhood Chain automatically (Chainlink CCIP, sent by Chainlink CRE).

## Already running on the server (nothing to do)

| Service | What it does |
|---|---|
| Chainlink CRE keeper | Writes the strike and observations every minute when due; sends queued collateral releases |
| Demo investor autopilot (`sn-arb-demo-investor`) | Investor `0xAce907325A6331D1f996D6f8CfA23D353213aA02` subscribes **20** units to the next note named **TSLA Reverse Convertible** as soon as its book opens, and claims every payout (receipt per claim) |
| Issuer bot | Only for the operator's notes. **The presenter's note is NOT funded by it**: the presenter funds each payment (step 6) |

## Prerequisites (check before recording)

- Chrome (or Edge) with **MetaMask**, unlocked, on the presenter's wallet (the issuer).
- That wallet holds:
  - a little ETH on **Arbitrum Sepolia** (421614) and on **Robinhood Chain testnet** (46630), for gas and the CCIP fee;
  - at least **1 TSLA** on Robinhood Chain testnet (Robinhood's token `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`);
  - at least **21 USDG** on Arbitrum Sepolia (`0xFFC95faa3d63Cde504a05B567C600B78C0b41892`) to fund 2 coupons + redemption;
  - a **verified email** (notes.markets/app → Alerts). Do this before recording; it needs a 6-digit code from the inbox.
- The app's **Get testnet tokens** menu links every faucet (Paxos USDG, Robinhood faucet, Arbitrum Sepolia ETH).
- Screen recorder: OBS Studio (recommended: 1920×1080 or 1440×900 window capture, 30 fps) or Loom. Keep MetaMask
  popups inside the captured area (record the full screen, not just the tab).
- Reload any notes.markets tab opened earlier (a "newer version is live" banner appears on stale tabs).

## How to drive the browser

Use the presenter's real browser so MetaMask is available:
- **Preferred:** Playwright attached over CDP to the presenter's Chrome. Close Chrome, then start it with
  `chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data"` (their normal
  profile, so MetaMask is there), and `chromium.connectOverCDP('http://127.0.0.1:9222')`. Or use Claude in Chrome.
- **Never automate the MetaMask popup.** When a step opens MetaMask, pause and tell the presenter what to check and
  sign (network, amount), then wait for the page to confirm.
- Move the mouse and scroll slowly; pause ~2 s on each screen so the edit has clean frames.

## The run, with exact values

Start the recording, then:

1. **Open** `https://notes.markets/app/issue?product=reverse-convertible&demo=tsla&step=0`.
   Every field is pre-filled. Check on screen, then click **Continue** on each step:
   - Product: underlying **TSLA**, network **Arbitrum Sepolia**, settlement **Cash**, name **TSLA Reverse Convertible**, issue price **100%**.
   - Terms: observations **2**, coupon each period **2.5%**, knock-in **70%**.
   - Schedule: size **20** USDG, book closes in **5** minutes, observe every **3 minutes**.
   - Collateral: held on **Robinhood Chain**, assets **TSLA** only, ratio **100%**, pay holders within **60** s, grace **120** s,
     TSLA counted at **60%**, on a default **What they're owed**, payouts **By claiming them**.
2. **Connect Wallet** (top right) → MetaMask → presenter approves.
3. On **Review & issue**, in **Lock on Robinhood Chain**: token **TSLA**, amount **1** → **Lock**.
   MetaMask switches to Robinhood Chain testnet; presenter signs the approval and the lock (it carries a small CCIP fee).
   The panel shows a "Follow on CCIP" link.
4. **Wait ~21 minutes** (pause the recording). Poll until the panel reads "1 TSLA locked on Robinhood Chain, ready to
   pledge" (refresh the page if needed; the wizard keeps its place in the URL).
5. Resume recording. Set **TSLA on Robinhood Chain pledged: 1**, **Strike in (minutes): 5** → **Issue**.
   Presenter signs each MetaMask step (register/publish the definition if prompted, approve TSLA.rh, start, terms).
   The page opens the note. The investor autopilot subscribes within ~15 s (book shows 20 sold).
6. Stay on the **note page** and let it play. It updates live:
   - +5 min: **strike** written by Chainlink CRE (TSLA ≈ $372.07 from Robinhood Chain's feed).
   - +8 min: observation 1 → **Fund payment** appears → click it, presenter signs (0.5 USDG).
   - +11 min: observation 2 (maturity) → **Fund payment** → presenter signs (20.5 USDG: coupon + redemption).
     If the wallet is short, first click **Withdraw** on "Proceeds to withdraw: 20 USDG" on the same page.
   - Within ~1 min of each funded payment the autopilot claims it (receipts appear under the investor in the history).
7. When the note shows **Paid in full**, the presenter's TSLA collateral is released automatically: the issuer bot
   does not touch this note, so click **Withdraw** / **Release to Robinhood Chain** on the collateral row if it is
   offered, and the presenter signs; the release is queued and **Chainlink CRE sends it within ~1 minute**. The
   portfolio shows "Released to your wallet on Robinhood Chain" with a CCIP link.
8. Optional: **Portfolio** (the presenter's view) and **Alerts → Emails sent** → **Show my emails** (presenter signs a
   free message) to show the emails from this run.
9. ~18 minutes later the TSLA is back on Robinhood Chain: show the presenter's address on
   `https://explorer.testnet.chain.robinhood.com/address/<presenter address>` (token balances), or the CCIP message page.

## Checkpoints the agent can poll (no keys needed)

- Notes list: `GET https://notes.markets/api/notes` → find `TSLA Reverse Convertible` on engine
  `0x7d36da43724b09bb03ed98a4574685070073020b`; `view.phase` goes `book` → `live` → `redeemed`.
- One note: `GET https://notes.markets/api/notes/arbitrum-sepolia%3A0x7d36da43724b09bb03ed98a4574685070073020b%3A<pid>`.
- Release queue: `eth_call` to gateway `0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89` `releaseQueue()` on
  `https://sepolia-rollup.arbitrum.io/rpc` (returns pending, head, queued, pool, nextFee).
- CCIP: `https://ccip.chain.link/msg/<messageId>` (linked from the page).

## If something goes wrong

- **A transaction is refused:** the app now shows the engine's reason in plain words; read it out and fix (most
  often: email not verified, not enough USDG, wrong network in MetaMask).
- **Missed a funding window:** after the 120 s grace the note defaults and the TSLA collateral goes to the investor,
  released to *their* address on Robinhood Chain. That is also a valid demo ("what if the issuer misses a payment").
- **CCIP slow:** keep recording the note page; cut the wait in the edit.
- **Fallback footage:** the live proof from 24 Oct (lock → note → strike → TSLA home), every transaction listed in
  `docs/CROSS-CHAIN.md` under "Live v2 proof".

## Edit plan (1:50)

Follow `docs/DEMO-SCRIPT.md`: issue (0:10–0:40) → subscribe (0:40–0:55) → CRE strike (0:55–1:10) → claim with receipt
(1:10–1:25) → collateral home with CCIP link (1:25–1:40) → tests green / Alerts emails (1:40–1:50). Cut every wait.
