# @sn/evm-engine

`FlowEngine.sol` runs compiled StratosNotes workflows (structured notes as BPMN) on EVM chains: Arbitrum Sepolia and
Robinhood Chain testnet (Arbitrum One by config). It is a port of the hackathon's Solana engine (StratosNotes `solana/programs/flow_engine`),
with the same semantics. Chainlink CRE is its calculation agent: oracle values arrive as DON-signed reports
through the KeystoneForwarder (`onReport`).

## Setup

`lib/` is gitignored. Fetch the pinned dependencies:

```bash
git clone --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std lib/forge-std
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
```

Then:

```bash
npm run fixtures   # compile every product with packages/core -> test/fixtures/products.json
forge test         # 13 tests: every product vs its reference payoff, plus the guards
forge test --isolate -vv --match-test test_gasWithManyHolders   # gas per report, each call its own transaction
```

## How a definition is stored

Its bytes are `CORE ‖ META` (packages/core/src/compile-evm.ts):
- **CORE** is what the engine executes: fixed-width big-endian records behind offset tables, a few KiB.
- **META** holds the names and term-sheet JSON.

`registerDefinition(bytes)`:
1. Computes the id as `sha256(bytes)`, the same id as on every chain.
2. Validates every offset and index in CORE (`DefCheck.check`, a linked library so its code is not part of the
   engine's 24 KiB; `forge script` and `forge test` link it automatically).
3. Stores CORE once as contract code (SSTORE2).
4. Emits META in `DefinitionRegistered` for the indexer.

Each transaction copies CORE into memory with one `EXTCODECOPY` and reads steps by offset. CORE may be up to
24,575 bytes; today's products are 3 to 10 KiB with the funding cycle drawn in (18 KiB for 12 observations).

## Escrow, balances and time (the note's economics)

A note raises funds against collateral (docs/NOTE-ECONOMICS.md), and the workflow draws the whole cycle; the engine
provides three generic mechanisms for it:

- **Escrow role.** A pool the definition marks escrow (role flag bit 0) is held by the engine at `ESCROW`, an
  address no key controls. `startProcess` refuses anything but `address(0)` for it; no step may act as it
  (`DefCheck`); units cannot be transferred to it. So pledged collateral and funded payments on its account cannot
  be withdrawn or moved except by the workflow's own operations (paying holders from escrow, the default
  distribution, the release to the issuer).
- **Expressions read accounts and time.** Op 18 `balance(role, asset)` reads a role's ledger balance (an open
  role has no account: the expression waits); op 19 `now` is `block.timestamp`. Gateways and guards use them:
  `balance(Escrow, cash) >= dueTotal`, `now >= payDate + grace`. Expression captures into date, int and bool fields
  are stored plain (a payment date computed as `obsDate1 + lag` is unix seconds).
- **Milestones.** A step can carry a business-event code (the high nibble of its flags); the engine emits
  `Milestone(pid, code, step, actor)` when it completes: 1 collateral pledged, 2 released, 3 funding deposited,
  4 margin call, 5 margin call cured, 6 payment made, 7 payment missed, 8 defaulted.

## Calls

| Call | Who | What |
|---|---|---|
| `registerDefinition(data)` | anyone | publish a workflow (idempotent) |
| `startProcess(def, ref, roles, assetTokens, startStep, inputs)` | the start step's role | a new issuance. `roles[i] = 0` makes an OPEN role (e.g. investors). `assetTokens[i]` is the ERC-20 behind a cash asset |
| `executeStep(pid, step, choice, inputs)` | the step's role (anyone for OPEN) | user tasks, decisions, subscriptions. Deposits pull ERC-20 from the caller (approve first) |
| `poke(pid)` | anyone | run what is due |
| `onReport(metadata, report)` | KeystoneForwarder only | `report = abi.encode(uint256 pid, uint16 step, int256[] values)`. `step = 0xFFFF` only advances. `0xFFFE` is reserved for cross-chain payouts |
| `fallbackReport(report)` | the fallback reporter only | the same report, from a signed keeper where CRE cannot write (services/keeper-fallback). Off by default |
| `deposit` / `withdraw(pid, asset, base)` | holder | ERC-20 in and out of the process vault. `withdraw` works while paused |
| `transferUnits(pid, asset, to, amount)` | holder | move note units, in whole or in part |
| `pause` / `unpause`, `setForwarderAddress`, `setExpectedWorkflowId/Author/Name`, `setFallbackReporter` | owner (two-step) | admin |
| `ESCROW()` | view | the address the engine holds escrow roles at |

Inputs are `(uint8 tag, bytes32 data)`:
- tag 1 is a number: an int256, fixed point with 10 decimals, or a plain integer for dates.
- tag 2 is text: UTF-8, left-aligned.
- tag 3 is a party: an address, right-aligned.

`evmInput` in packages/core builds them.

## Events (the indexer's input)

| Event | When |
|---|---|
| `DefinitionRegistered(id, creator, pointer, meta)` | a workflow is published |
| `ProcessStarted(pid, definition, creator, ref, roles, assetTokens)` | an issuance starts |
| `StepRun(pid, step, kind, actor)` | a step completes (`actor` = 0 for straight-through and reports) |
| `FieldSet(pid, field, tag, value)` | a field is captured |
| `HoldingChanged(pid, asset, owner, balance)` | after every ledger change |
| `TokensUpdated(pid, status, stepsRun, tokens)` | once per transaction: the live BPMN tokens |
| `Deposited` / `Withdrawn(pid, asset, account, base)` | ERC-20 in or out |
| `UnitsTransferred(pid, asset, from, to, amount)` | secondary transfer |
| `ReportProcessed(pid, step, values, reporter)` | a report is applied; `reporter` is the KeystoneForwarder (CRE) or the fallback reporter |
| `FallbackReporterUpdated(previous, next)` | the owner changed the fallback reporter |
| `Milestone(pid, code, step, actor)` | a step marked as a business event completes (collateral, funding, payments, margin calls, default) |
| `ProcessCompleted(pid)` | no tokens left |

## NotesLens

`NotesLens` (deployed with the engine) is what keepers read:
- **`publish(data)`** stores a registered definition's full bytes (CORE and META), content-addressed and
  checked against the engine. Keepers need META for the oracle feeds, and CRE reads state at a finalized
  block rather than from events.
- **`definitionBytes(id)`** returns them.
- **`running(from, scan, max)`** returns every running process's definition, status, tokens, captured values and
  every role's balance of every asset (escrow included) in one paged call, so a keeper sees what a "Funded?"
  check sees.

It holds no funds and has no owner.

## Caps and gas

Each cap bounds a loop:

| Cap | Value |
|---|---|
| Roles | 8 |
| Fields | 64 |
| Assets | 8 |
| Live tokens | 32 |
| Ledger accounts per process | 64 |
| Straight-through steps per transaction | 256 |
| ERC-20 pulls per step | 4 |

Measured with `forge test --isolate` (each call priced as its own transaction, cold storage), 2026-10-24:

| | Gas |
|---|---|
| Subscribe | 342k (max over the 20 timelines) |
| Issuer funds a payment (deposit + move into escrow) | 218k |
| Largest report in the 20 timelines | 742k |
| Strike report with the margin check, 30 or 62 holders | 484k |
| Observation with the margin check, 30 or 62 holders | 344k |
| Payment date, coupon paid from escrow to 30 holders | 1.29M |
| Payment date, coupon paid from escrow to 62 holders | 2.33M |
| Default (cap-at-owed), owed to 30 holders, rest to the issuer | 2.79M |
| Default (cap-at-owed), owed to 62 holders, rest to the issuer | 5.01M |
| Default (all-to-holders), cash + USDC + ETH collateral to 62 holders | 4.79M |

Both target chains run Arbitrum Nitro (32M gas per transaction). The CRE workflow's write gas limit is 8M (CRE
allows 10M per write); the forwarder adds signature checks on top, and Arbitrum adds L1 data gas. A first payment
costs most, because each holder's balance goes from zero to non-zero (20k gas). A default pays every escrow asset to
every holder: with the 8-asset cap, at most 8 x 64 credits.

The engine's runtime is 22,992 bytes (the EIP-170 limit is 24,576); `DefCheck` (3,563 bytes) is a separate linked
library. Phase 5's CCIP sender and receiver must go in a separate contract.

## Deploying

```bash
CHAIN=arbitrum-sepolia FORWARDER_MODE=mock OWNER=<deployer> TEST_TOKENS=1 \
  forge script script/Deploy.s.sol --rpc-url <rpc> --private-key <key> --broadcast
```

- **Output:** writes `deployments/<chain>.json` at the repo root.
- **Forwarder:** `FORWARDER_MODE=mock` trusts the MockKeystoneForwarder, which `cre workflow simulate --broadcast` writes through. `production` trusts the KeystoneForwarder. Robinhood mainnet has no CRE forwarder yet: pass `FORWARDER`.
- **Test tokens:** `TEST_TOKENS=1` (testnets only) also deploys tUSD, tETH, tBTC, tSOL, tTSLA, tNVDA, tAAPL and
  tSPY (`src/test-tokens/TestToken.sol`) and a `TokenFaucet` that mints a fixed amount of each, once an hour per
  account. The deployer must be `OWNER` for this (it sets the faucet as minter).
- **Gas:** the engine needs about 6.7M gas of execution; see docs/DEPLOY.md for per-chain funding.
- **EVM version:** the build targets the Paris EVM (no PUSH0 or MCOPY), so one bytecode runs on every target chain.

## Differences from the Solana engine

- **Processes** have numeric ids (`processCount`), not PDAs. Holders are addresses. There is no `open_vault`: the
  engine holds every process's ERC-20, and each process's vault balance is tracked (`vaultOf`).
- **Numbers** are int256 with Solidity's checked arithmetic. Solana uses checked i128, so values that overflowed
  there may succeed here. Truncation is identical: toward zero, `a*b/1e10` and `a*1e10/b`.
- **Distribute** debits the payer once for the whole distribution rather than once per holder. The outcome and
  the failure condition are the same.
- **Ledger cap:** 64 accounts per process (any assets). Solana allowed 64 (owner, asset) entries.
- **Deposits:** up to 4 ERC-20 pulls per step (Solana: 1). Fee-on-transfer tokens are refused.
- **Start step:** `startProcess` checks that cash assets are contracts and issued assets have no token.
- **Pause:** pausing stops new actions but not withdrawals or reports.
- **Not yet ported:** CCIP. `ccip_receive`, `withdraw_remote`, the outbox and payout reports (`0xFFFE`) come in
  Phase 5.
