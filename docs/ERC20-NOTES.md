# Note units as ERC-20s, with scale-free payouts pushed to wallets (engine v4)

Each note's units are a standard ERC-20 (`NoteToken`): wallets show them, explorers index them, and holders send
them with `transfer` / `transferFrom` / `permit`. Coupons, redemptions, physical delivery and a default's
distribution cost the same with 10 holders as with 10,000. A keeper pushes each payout to holders' wallets in
batches, and every payment carries a receipt id that anyone can recompute from the logs.

Code: `packages/evm-engine/src/NoteToken.sol` (the token), `src/lib/Units.sol` (ledger, accumulator and push, an
external linked library), `src/FlowEngine.sol` (wiring and the transfer hook). Tests: `test/NoteTokens.t.sol`,
plus every product suite rerun against the reference payoff in claim mode and in push mode.

## 1. The token

| | |
|---|---|
| Deployment | One EIP-1167 clone per issued asset, created by `startProcess` (45 bytes of code each). The implementation is deployed by the engine's constructor. |
| Name / symbol | Passed to `startProcess`, e.g. `notes.markets ETH/BTC Phoenix 26-10` / `nmETHBTC1` (`sdk noteTokenMeta`). |
| Decimals | **6**. The engine's fixed point has 10 decimals, so 1 token base unit = 1e4 engine units. The engine mints, burns and moves only whole token base units (`InexactUnits` otherwise), so the mapping is exact. |
| Balances | Stored in the token (standard ERC-20 storage). **The token is the single source of truth for units.** The engine keeps no unit balances of its own. |
| Supply | `totalSupply == sold − burned`. Subscriptions mint, the issuer's unsold units are burned at the strike, and the redemption retires the rest (see §4). |
| Mint / burn / workflow moves | `engineMint`, `engineBurn`, `engineMove`, `engineRetire`: callable only by the engine. |
| Holder transfers | `transfer`, `transferFrom` and EIP-2612 `permit`. Each calls `engine.beforeNoteTransfer` first (§3). |
| Holder set | Enumerable (`holderCount`, `holderAt`, `holders(start, count)`): the addresses with a non-zero balance, maintained with swap-and-pop. This is what a push walks. |

`FlowEngine.assetTokenOf(pid, 0)` returns the token, `NoteTokenCreated(pid, asset, token)` announces it, and the
API and the app expose it ("Add to wallet" calls `wallet_watchAsset`).

## 2. Payouts: one accumulator per (note, holding, asset)

A workflow's `DISTRIBUTE` used to loop over every holder (with a cap of 64 ledger accounts). It now does one O(1)
update:

```
eligible = token.supply x 1e4 − payer's units        (0 once the units are retired)
total    = floor(eligible x perUnit / 1e10)          debited from the payer at once
acc     += floor(total x 1e30 / eligible)            MAG = 1e30
```

A holder's share is settled lazily, on each holding × asset pair:

```
owed        = floor(units x (acc − checkpoint[holder]) / 1e30)
checkpoint := acc
```

Settlement runs before any change to the holder's units: a mint, a burn, a workflow move, a holder transfer. It
also runs on a withdrawal, on a workflow debit or credit of the account, and when a push reaches the holder. So
**each payout goes to whoever held the units when it was made**, however the units move afterwards.

- **Rounding is in the protocol's favour.** Every step floors, so the holders' shares never add up to more than
  `total`. The remainder stays in the vault as dust: under one engine unit (1e-10) per holder per payout on the
  ledger, and under one token base unit per payment when pushed (§5). The fuzz test bounds both.
- **The payer's own units take no share.** The payer is settled first, then excluded from `eligible`, and its
  checkpoint is moved past the payout. An issuer holding unsold units, or paying a coupon on units it bought
  back, never needs cash for its own book.
- **Defaults.** Both rules work unchanged on top of this. `cap-at-owed` distributes each escrow asset at
  `take_a / sold` and transfers the remainder to the issuer. `all-to-holders` distributes `balance(ESCROW, a) / sold`.
  Collateral held as cross-chain receipts (`RemoteReceipt`) is an ordinary cash asset here: holders withdraw the
  receipts and redeem them on the asset chain (`test/CrossChain.t.sol`, every remote-collateral run).
- **Physical delivery** distributes the delivered token per unit through the same accumulator. Tested with an
  18-decimal deliverable.
- **Expressions.** `balance(role, asset)` reads the token for issued assets (zero once retired). For cash it reads
  the ledger plus the accrued payouts, so "Funded?" and the default arithmetic see exactly what the old loop left
  on each account.

## 3. Verified-only transfers

`beforeNoteTransfer(pid, asset, from, to, amount)` is the only entry the token calls.

- It answers only the note's own token.
- It is `nonReentrant` and `whenNotPaused`.
- It refuses `to` = ESCROW or the engine.
- It requires the note to be running (`NotTransferable` once it has completed).
- With `requireEmail` on, it requires a current verified-email attestation for `to`
  (`RecipientEmailNotVerified(to)`).
- There is no allow-list of contracts. A smart wallet or a marketplace contract can hold units if it has an
  attestation, like anyone else.
- It then settles both sides at their current balances. It emits `HoldingChanged` for both, with the balances the
  token is about to write, and `UnitsTransferred`.

`transferFrom` through an approved spender, and `permit`, go through the same hook. The engine's old
`transferUnits` is gone: a transfer is a token transfer (the SDK's `transferUnits` sends it, after checking the
recipient's attestation so the app can explain a refusal).

**Why the indexer needs no token logs.** Every unit balance change (mint, burn, workflow move, holder transfer)
appears as an engine `HoldingChanged`. A holder transfer also logs `UnitsTransferred`, so the read model gets
transfers from the engine's own logs. It doesn't have to discover and index one `Transfer` stream per note token.

## 4. Phases

| Phase | Transfers | Payouts |
|---|---|---|
| Book open, live | allowed (verified recipients) | accrue to holders at each payment |
| Redeemed (a `DISTRIBUTE` with retire) | refused: `balanceOf` and `totalSupply` read 0 | the redemption made in the same step is still paid in full (the engine reads the raw balances, `heldOf`); nothing accrues afterwards |
| Completed (a default, or after redemption) | refused (`NotTransferable`) | what was accrued stays withdrawable and pushable |

Retiring is one write (`engineRetire`) whatever the number of holders. The units stay recorded (`heldOf`,
`supplyHeld`) for the payouts they earned.

## 5. Push: paying wallets directly

The accumulator is the source of truth. A push only moves what it says a holder is owed.

| Function | Who | What |
|---|---|---|
| `pushPayouts(pid, asset, start, count)` | anyone (the caller pays gas) | Pays holders `[start, start + count)` of the token's holder set. With `start = type(uint256).max` it continues from the round's cursor ("push the next N"). Returns how many holders remain after the cursor. |
| `pushTo(pid, asset, holders[])` | anyone | Pays these addresses their accrual **plus payouts already on their account**: a holder who sold between a distribution and its push, or a deferred payment to retry. Cash the workflow put on an account (an issuer's raised funds) is never swept: the engine tracks which ledger balance came from payouts. |
| `withdraw(pid, asset, base)` | the holder | Unchanged fallback: settles, then pays what is on the account. |

- **Failure-safe.** Each transfer runs with a 150k gas cap and copies at most 32 bytes of return data. If it fails
  (a frozen or paused stablecoin, a blocked address, a reverting token), the batch carries on. The amount stays
  on the holder's account (claimable, and retried by `pushTo`) and `PayoutDeferred` is logged.
- **No double pay.** A push moves the holder's checkpoint, and a claim settles first. Whatever one pays, the other
  sees as zero (tested both ways).
- **Order.** A transfer after a distribution but before its push settles the seller first, so the seller keeps
  that payout and the buyer gets none of it (tested). Swap-and-pop can reorder the holder set mid-round, so a
  holder may be skipped by the cursor. The keeper then finishes with `pushTo` for any address with a claimable
  balance (`NotesLens.claimable`). Nothing is ever lost: the worst case is claimable instead of pushed.
- **Who pushes.** `scripts/issuer-bot.ts` pushes every open round after each payout, in batches of `PUSH_BATCH`
  (100). The demo backend runs it as a payout keeper (`PUSH_ONLY=1`). The CRE report path does **not** push.
  Doing it there would make a report's gas grow with the book, and the engine has 525 bytes left. A push is
  permissionless, so any keeper, the issuer or a holder can run it.

### Receipts: the hash log

| Event | Fields | Hash |
|---|---|---|
| `DistributionRecorded` | pid, asset, **period**, holding, step, payer, perUnit, total, supplyAtPayment, retire, distributionHash | `keccak256(abi.encode(chainid, engine, pid, asset, period, perUnit, supplyAtPayment))` |
| `PayoutPaid` | pid, asset, period, holder, amount (token base units), payoutId | `keccak256(abi.encode(chainid, engine, pid, asset, period, holder, amount))` |
| `PayoutDeferred` | pid, asset, period, holder, amount | none |
| `DistributionSettled` | pid, asset, period, paidCount, paidTotal, rollingHash | `r_0 = 0`, `r_i = keccak256(abi.encode(r_{i-1}, payoutId_i))`, in push order |

- **Period.** `period` counts the distributions of one cash asset on one note, starting at 1. Coupons, the
  redemption, a delivery and each asset of a default are all distributions. The `step` field says which BPMN step
  made it (Task_Pay2, Task_Default, …), and `retire` marks the redemption.
- **A push pays the latest period.** A holder's payment in period P includes anything still accrued from earlier
  periods of that asset.
- **Superseded rounds.** A round ends with `DistributionSettled` when the cursor passes the last holder, or when the
  next distribution of that asset supersedes it. Its count, total and rolling hash then cover what was pushed.
- **Checking it.** The SDK's `payoutId`, `distributionHash`, `rollingHash` and `verifyPayouts(events)` recompute
  every value from the logs alone. `packages/sdk/test/payouts.test.ts` checks them against Solidity's
  `abi.encode`. `test_pushThousandHoldersInBatchesWithReceipts` recomputes 1,000 payoutIds and the rolling hash
  from the logs, and the local e2e does the same against a running stack.

### What a holder sees

- **"Paid to your wallet"** (portfolio): every `PayoutPaid` to the address, with the payoutId linking to the
  transaction (`/api/portfolio/:address` returns `payouts`).
- **"To withdraw"**: only what is left, read from the chain (`balanceOf`: deferred or not-yet-pushed payouts, plus
  an issuer's raised cash).
- **The read model** (indexer and D1) credits each holder at `DistributionRecorded`, from the unit balances it
  tracks. Every later `HoldingChanged` for that cash account is absolute and already includes everything accrued.
  A push logs `PayoutPaid`, then the account's new balance. So the model stays exact without per-holder payout
  events. The notifier's "you were paid" amounts come from the same fold (`txDeltas`).

## 6. Gas

`forge test --isolate` prices each call as its own transaction, with cold storage and the 21k base, which is what a
chain charges.

| Report (CRE or fallback) | 10 holders | 1,000 holders |
|---|---|---|
| Coupon paid to every holder | 393,001 | 393,344 |
| Default: cash, USDC and ETH collateral distributed to every holder (cap-at-owed) | 1,000,808 | 1,001,323 |
| Default, all-to-holders | 716,712 | 717,722 |
| Strike, with the margin check | 535,470 | 536,412 |

The v3 engine cost 2.34M gas for a coupon to its maximum of 62 holders, and 5.01M for a default.

| Holder-side operation | Gas (isolated) |
|---|---|
| Note token transfer to a new holder (settles both sides) | 263,054 |
| Note token transfer to an existing holder | 175,929 |
| `pushTo` one holder (a whole transaction) | 152,205 |
| Claim (`withdraw`) of a settled payout | 106,200 |
| Push, **per holder** inside a batch (1,000 holders, 10 transactions of 100; each wallet's first payment) | 55,251 |

A push of 100 holders is therefore about 5.6M gas, well inside a block. A holder owed nothing costs about 10k gas to
skip. (The per-holder push figure is measured inside one test transaction, with the round's own storage warm and
each holder's storage cold, as it is in a real batch.)

## 7. Trade-offs

- **Push vs pull.** Pull alone is O(1) for the issuer but leaves every holder to claim. Push alone, inside the
  payment, is O(n) and fails as a whole if one holder is blocked. Here the payment is O(1) (the CRE report stays
  small and fixed), money reaches wallets through a separate permissionless batch, and claim remains the fallback.
- **The cost of a transfer.** A holder transfer settles both sides and asks the engine, so it costs 176k–263k gas,
  against 35k–52k for a plain ERC-20. That is the price of exact payouts per holder at payment time, and of
  verified-only transfers.
- **Dust.** Pushing rounds each payment down to a whole token base unit (1e-6 USDG). What is left, under one base
  unit per payment, stays on the account and is withdrawn with the next payment or a claim.
- **Engine size.** FlowEngine is 24,051 / 24,576 bytes. Units (11.7 KB), DefCheck and EmailAttest are linked
  libraries, and the NoteToken implementation is created by the constructor (it is in initcode, not runtime).
  `transferUnits`, `holdersOf` and `MAX_HOLDERS` were removed.

## 8. Compatibility and upgrade path

- **New events:** `NoteTokenCreated`, `DistributionRecorded`, `PayoutPaid`, `PayoutDeferred`, `DistributionSettled`.
- **Changed ABI:** `startProcess(…, name, symbol)`; `transferUnits` and `holdersOf` removed; `pushPayouts`, `pushTo`,
  `pendingOf` and `beforeNoteTransfer` added.
- **Unchanged:**
  - `withdraw`, `deposit`, `executeStep`, `poke`, reports (CRE and fallback), funding windows, margin, email gating
    and the cross-chain gateway.
  - `balanceOf(pid, owner, asset)` (units from the token; cash = ledger + accrued) and `assetTokenOf` (now also the
    note token).
  - `NotesLens.snapshot` / `running`. The lens adds `position`, `claimable` and `holders`.
- **v3 notes stay on the v3 engine.** Engines aren't upgradeable, and nothing migrates. The indexer keys notes by
  engine address, so v3 notes keep their history and pages. Once the app moves to v4 they take no new
  subscriptions, but holders still withdraw, transfer (the v3 ledger `transferUnits`) and settle them on the v3
  engine. New issuance goes to v4.
- **Old read-model rows are unaffected.** A v3 note never emits the new events.

## 9. v4 redeploy plan (testnets; needs approval, nothing deployed yet)

Balances on 2026-10-24: the deployer holds ~0.021 ETH on Arbitrum Sepolia and ~0.0022 ETH on Robinhood Chain
testnet, plus 90 USDG on Arbitrum Sepolia.

| Chain | Gas | At today's price |
|---|---|---|
| Arbitrum Sepolia (0.02 gwei) | Units 2.62M + FlowEngine 6.62M (with the NoteToken implementation) + NotesLens 1.67M + setEmailPolicy ≈ **11.0M** | ≈ 0.00022 ETH |
| Robinhood Chain testnet (0.01 gwei) | the same ≈ 11.0M | ≈ 0.00011 ETH |

DefCheck and EmailAttest are already deployed at their deterministic addresses and are reused. Gas was measured by
the local fork deployment of `scripts/dev-local-d1.sh`. The deployer has enough on both chains for the contracts.
The seeded demo notes and the investors' gas (0.001 ETH each) need about 0.004 ETH more on Robinhood Chain testnet:
top up from https://faucet.testnet.chain.robinhood.com first.

1. **Rehearse.** `REHEARSAL=1 SEED=1 bash scripts/deploy-testnets.sh` against local forks of both chains.
2. **Deploy.** `bash scripts/deploy-testnets.sh` deploys the engine and lens on both testnets with the same
   verifier and `requireEmail`, the MockKeystoneForwarder, and the fallback reporter off. It writes
   `deployments/<chain>.json` and the CRE and server configs. Move the v3 files to `deployments/archive/v3/`.
3. **Cross-chain.** Deploy a fresh pair for v4 with `script/DeployCrossChain.s.sol`: a gateway and receipts on
   Arbitrum Sepolia (`ENGINE` = v4) and a RemoteVault on Robinhood Chain testnet. The cost is about 2M gas more per
   chain. The v3 gateway–vault pair stays as it is, so collateral locked for v3 notes is still released through its
   own gateway.
4. **Read model.** Each chain lists its earlier engines (`legacyEngines`, from `deployments/archive/v<N>/`, written
   by `scripts/server-config.ts` into `deployments/server/{indexer,api}.json`). The D1 indexer keeps one `chains`
   row per (chain, engine): the current engine under the chain key, v3 under `<chain>-v3`. On its first cron the
   Worker moves the v3 row (indexed under the chain key until now) to `<chain>-v3` with its cursor and block
   hashes, so nothing is re-indexed and v3 note ids (`<chain>:<v3 engine>:<pid>`) stay the same; then v4 indexes
   from its deployment block under the chain key. Apply `web/migrations/0003_payouts.sql` and
   `0004_engines.sql` (events get their engine, so a reorg on one engine never undoes the other's) first.
   The app serves v3 notes with the v3 engine, lens and cross-chain pair (`packages/sdk/src/evm/abi-v3.ts` for
   the ledger transfer): they show as "Earlier engine", take no new subscriptions, and holders withdraw and
   settle there.
5. **Workers and bots.** Deploy the Worker (`npm run deploy`, from a clean worktree of origin/main). Restart the CRE
   keeper config. Restart `sn-arb-issuer-<chain>` with push on (the default), and add a `PUSH_ONLY=1` payout keeper
   if the issuer bot isn't running for every note.
6. **Seed and verify.** Seed a note per chain (`scripts/seed.sh`), subscribe two investors, let a coupon run, then
   check:
   - the wallets received it (`PayoutPaid`);
   - `verifyPayouts` passes on the note's history;
   - the portfolio shows "Paid to your wallet";
   - "Add to wallet" shows the units.

   Record the transactions in docs/evidence.json.
