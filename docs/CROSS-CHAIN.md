# Cross-chain collateral (stage 1)

Notes run on **Arbitrum** (Arbitrum Sepolia today): the FlowEngine there holds the note's state, schedule,
holders, payments and default rule. **Collateral stays on the chain where it lives**: Robinhood Chain's tokenized
stocks (TSLA, AMZN, NFLX) and Paxos USDG are locked in place in a vault on Robinhood Chain. Chainlink **CCIP**
carries the two value commands between the chains, and Chainlink **CRE** checks every run that each vault still
backs what the note counts. Nothing is bridged and no wrapped token can be traded.

Status: built and tested locally (Chainlink Local, mock routers) and on forks of both testnets with the real CCIP
routers. **Not deployed to any testnet yet**; the deploy plan is at the end.

## How it works

```
        Robinhood Chain (asset chain)                          Arbitrum (home chain)
 ┌────────────────────────────────────────┐         ┌──────────────────────────────────────────────────┐
 │ RemoteVault                            │  LOCKED │ HomeGateway ──mints──► RemoteReceipt (TSLA.rh)    │
 │  lock(TSLA, 3, issuer) ───────────────────CCIP──►│                          │  pledged as collateral │
 │  locked[TSLA] += 3                     │         │                          ▼                        │
 │                                        │         │ FlowEngine: escrow, coverage (price x haircut,     │
 │                                        │         │   summed over local + remote collateral), margin, │
 │                                        │         │   release at maturity, default (cap-at-owed)      │
 │  pay TSLA to issuer / holder ◄──────────CCIP────│ redeem(receipt) burns it ──► RELEASE              │
 │  locked[TSLA] -= amount        RELEASE │         │                                                    │
 └────────────────────────────────────────┘         └──────────────────────────────────────────────────┘
          ▲                                                       ▲
          └──────── Chainlink CRE reads both every run ───────────┘
                    (vault balance vs locked vs receipts outstanding)
```

1. **Lock.** The issuer locks real TSLA in the vault on Robinhood (`lock(token, amount, beneficiary)`, CCIP fee
   in native ETH). The vault sends **LOCKED**; the gateway on Arbitrum mints the same amount of `TSLA.rh` receipts
   to the beneficiary.
2. **Pledge.** The issuer pledges the receipts into the note at Approve Terms (or a margin top-up), exactly like a
   local collateral token. The note values them with TSLA's Chainlink price and the haircut the issuer set, and
   coverage sums every collateral asset, local or remote, on any number of asset chains.
3. **Run.** Observations, coupons, margin calls, the grace period and the default rule are the engine's
   unchanged, reference-tested paths.
4. **Paid in full.** The engine releases the receipts to the issuer, who **redeems** them: the gateway burns
   them and sends **RELEASE**; the vault pays the real TSLA back on Robinhood.
5. **Default.** The engine pays the receipts to the holders (cap-at-owed: what they are owed, the excess to the
   issuer). Each holder redeems their own receipts for real TSLA on Robinhood, to the same EVM address.

### Design decisions

- **No engine change.** The first design put a "remote collateral" hook in the engine. It is not needed: a
  receipt is an ERC-20 the engine already handles as collateral, so pledging, coverage, margin, release and both
  default rules run on code that every product test already checks against the reference payoff. The engine
  (23,384 / 24,576 bytes) stays as deployed and audited-in-progress.
- **Receipts are not a bridge.** `RemoteReceipt` moves only into or out of the engine (pledge in; release or
  payout out). It cannot be sent between people, so there is no tradable wrapped TSLA. It is minted only for a
  CCIP-verified lock and burned only on redemption.
- **Pull redemptions, not a pushed DISTRIBUTE.** On a default the engine credits each holder; each holder
  redeems when they like. One message per redemption keeps every CCIP execution small and bounded (about 82k gas
  on the vault, measured), whatever the number of holders, and a holder who never redeems costs nobody anything. A pushed
  batch to 62 holders would need a large destination gas limit and would fail as a whole if one transfer
  failed.
- **Authorisation without per-note registration.** The vault does not need to know which note a lock is for: the
  receipts go to the locker (or a beneficiary they name), and only a note's issuer can pledge into that note (the
  engine's role checks). So a lock can never be credited to someone else's note.
- **Many asset chains.** The gateway keeps an allow-list per (CCIP chain selector, vault), and one receipt per
  (chain, token). Adding a chain is configuration: deploy a vault there, `setRemote`, `registerReceipt`. The
  tests run one note with collateral on two remote chains at once (stablecoin on one, ETH on another).
- **Stablecoins and stocks can be frozen.** Paxos USDG and tokenized-stock issuers can pause, freeze or seize.
  A release to a frozen account does not revert (which would leave a stuck CCIP message): the amount is recorded
  as `unclaimed` and the account `claim`s it later. A seizure from the vault itself makes the vault's backing
  fall below `locked`; CRE reports it (see Trust).

## Message formats

Both are `abi.encode(uint8 kind, bytes32 id, address account, address remoteToken, uint256 amount)`, sent as
data-only CCIP messages (no CCIP token transfer), fee in native gas, `GenericExtraArgsV2{gasLimit,
allowOutOfOrderExecution: true}`:

| kind | Direction | `id` | `account` | Effect |
|---|---|---|---|---|
| 1 LOCKED | vault → gateway | `keccak(chainid, vault, lockNonce)` | receipt beneficiary | mint receipts (once per id) |
| 2 RELEASE | gateway → vault | `keccak(chainid, gateway, redeemNonce)` | recipient on the asset chain | pay the locked token (once per id) |

The gateway accepts LOCKED only from the vault configured for the message's source chain selector, and only
through its CCIP router; the vault accepts RELEASE only from the home chain selector and the configured gateway.

## State machines

- **Lock** `id`: (sent on the asset chain, `locked` already increased) → **credited** at home (receipts minted).
  A duplicate delivery of the same id is acknowledged and ignored. A lock of a token with no receipt yet reverts
  at home and stays executable: register the receipt, then execute the message manually.
- **Redemption** `id`: receipts **burned** at home → **paid** on the asset chain (`locked` decreased, token
  transferred) or **unclaimed** (recipient frozen; `claim` later). A duplicate is ignored. A release larger than
  what is locked reverts (cannot happen while the invariant holds) and stays executable.
- **Invariant:** `locked[token]` ≥ receipts outstanding at home, with equality when nothing is in flight; the
  vault's balance minus unclaimed ≥ `locked[token]` unless the token took tokens back.

## Trust and failure modes

- **What you trust:** Chainlink CCIP to deliver the authenticated message once (plus our id check), the gateway
  and vault owners to configure the right peer (they cannot move anyone's tokens), and the token issuers
  (USDG/stock tokens can freeze or seize: that is the asset's own risk and CRE reports it).
- **Latency.** A CCIP message executes after its source chain is final. For Arbitrum-family chains (Arbitrum
  Sepolia, Robinhood Chain testnet) that is the L1 (Ethereum) finality of the batch that includes the
  transaction: roughly 15–25 minutes per message (Chainlink's execution-latency guidance; not yet measured on
  these lanes; we will record it on the first testnet run). Earlier, on the Solana build, we measured 35–40 min
  Sepolia → Solana and about 1 min Solana → Sepolia. So: lock collateral well before the strike; size the
  grace period of a note with remote collateral at a few hours, not minutes; a margin top-up from a remote
  chain arrives ~20 minutes after it is sent (the test suite replays exactly this: the top-up fails until the
  message lands, then succeeds inside grace).
- **Retries and manual execution.** A message that reverts on the destination (e.g. a token not registered yet)
  stays in CCIP and can be executed manually from the CCIP Explorer after the cause is fixed; ids make that safe.
- **Stuck messages.** Out-of-order execution is on, so one failed message never blocks another lock or
  redemption.
- **Shortfall.** CRE reads `locked`, `unclaimedTotal` and the token balance of each vault and the receipts'
  `totalSupply` at home every run, and logs `[collateral shortfall]` (packages/core/src/crosschain.ts). In stage 1
  that is a report for operators and the app; stage 2 can let CRE write it into the note so coverage drops and a
  margin call opens.
- **Pause.** Pausing the gateway stops redemptions (outbound); pausing a vault stops new locks. Neither stops a
  release already sent, and holders can always claim.

## Fees and gas

- CCIP fees are paid in the native token (ETH on both chains; LINK also accepted by the routers). The caller of
  `lock` or `redeem` pays; `quoteLock` / `quoteRedeem` return the fee, excess is refunded.
- Destination gas limits: 200,000 for LOCKED (measured ~118k: decode, check, mint) and 300,000 for RELEASE
  (measured ~82k: decode, check, transfer; headroom for tokens with transfer hooks). Both configurable.
- Fees quoted by the real routers on forks (2026-10-24): lock on Robinhood ≈ 0.000067 ETH, redeem on Arbitrum
  Sepolia ≈ 0.000051 ETH per message.
- Bytecode: HomeGateway, RemoteVault and RemoteReceipt are separate contracts; the engine is unchanged.

## Stage 2 (next)

- Subscriptions from the asset chain: an investor pays USDG on Robinhood, the vault sends SUBSCRIBE, the gateway
  subscribes for them at home (units held for the same address).
- Payments to the asset chain: coupons and redemptions funded by the issuer on Robinhood and paid to holders
  there, with the engine as the ledger of who is owed what.
- Shortfall enforcement: CRE writes the vault backing into the note, so a seized vault opens a margin call.

## Testnet deploy plan (for approval)

Order (script: `packages/evm-engine/script/DeployCrossChain.s.sol`):

1. Arbitrum Sepolia: `ROLE=gateway` → HomeGateway (router `0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165`,
   engine = the v3 engine).
2. Robinhood Chain testnet: `ROLE=vault` → RemoteVault (router `0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C`,
   home selector `3478487238524512106`), allow USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F`, TSLA, AMZN, NFLX.
3. Arbitrum Sepolia: `ROLE=wire` → `setRemote(2032988798112970440, vault)`, receipts USDG.rh (6), TSLA.rh (18),
   AMZN.rh (18), NFLX.rh (18).
4. App and core: add the receipts as collateral options (valued with each stock's Chainlink feed), a "Lock on
   Robinhood" step in the issue flow and "Redeem on Robinhood" for holders; CRE staging config gets `vaults`.
5. A demo note on Arbitrum Sepolia with TSLA collateral locked on Robinhood: lock at least 30 minutes before the
   strike; grace period of a few hours.

Funding (estimates at testnet gas prices of ~0.01–0.02 gwei; CCIP fees quoted at run time):

| Address | Arbitrum Sepolia | Robinhood testnet |
|---|---|---|
| Deployer `0x298a…de0a` (deploy + wire) | ~0.001 ETH | ~0.001 ETH |
| Demo issuer (a few redeems; locks on Robinhood) | ~0.001 ETH | ~0.002 ETH |
| Demo holders (redeem after a default, ~0.00005 ETH each) | ~0.0005 ETH each | — |

Plus real Robinhood testnet stock tokens and USDG for the demo issuer (faucet.testnet.chain.robinhood.com).
CCIP lanes Arbitrum Sepolia ↔ Robinhood testnet are listed as live in both directions in Chainlink's CCIP API
(`/api/ccip/v1/lanes`, CCIP 2.0 on-ramps/off-ramps), checked 2026-10-24.
