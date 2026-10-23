# Security review: notes.markets contracts

Scope: `packages/evm-engine/src` (FlowEngine, its libraries Def / DefCheck / EmailAttest / SSTORE2, CreReceiver,
NotesLens) and the testnet-only TestToken / TokenFaucet. Solidity 0.8.24, via-IR, optimizer 200 runs, EVM Paris.
This is an internal review with static analysis, fuzzing and invariant testing. **It is not an audit**; an
independent audit is required before any mainnet deployment that holds real value.

Reviewed 2026-10-24 at the commit that adds this file.

## Roles and trust

| Role | Who | Can | Cannot |
|---|---|---|---|
| Owner (Ownable2Step) | deployer today; a multisig before mainnet | pause/unpause; set the KeystoneForwarder; set the expected CRE workflow id/author/name; set the fallback reporter; set the email verifier and `requireEmail`; revoke an email binding | move, freeze or withdraw anyone's balance; change a registered definition; run a person's step |
| KeystoneForwarder | Chainlink CRE | deliver reports (`onReport`): oracle values for a due oracle step, or an advance | report values outside a definition's per-field bounds; act on a step that holds no token |
| Fallback reporter | off by default; a signed keeper where CRE can't write (Robinhood mainnet) | the same as the forwarder, recorded with its address in `ReportProcessed` | anything else |
| Verifier | the API's attestation key | sign EIP-712 email attestations; revoke them | anything about notes or funds |
| Issuer | a note's creator | start it, approve terms, pledge collateral, fund payments, withdraw its proceeds | withdraw pledged collateral or funded payments (they sit on the engine-held ESCROW account) |
| Holders / investors | anyone (with a verified email when `requireEmail` is on) | subscribe while the book is open, transfer units, withdraw what the ledger credits them | take another holder's balance, or units from escrow |

Trust assumptions:
- **Prices.** CRE reads Chainlink feeds and the engine bounds-checks every value against the definition's
  min/max. Within those bounds the forwarder (or fallback reporter) is trusted to deliver the true price: a
  compromised owner who swaps the forwarder could report any in-bounds price. Mitigation: owner multisig and a
  timelock on `setForwarderAddress`, `setFallbackReporter` and `setExpectedWorkflow*`.
- **Timing.** Steps run on `block.timestamp`; deadlines are hours to days apart, so sequencer timestamp drift
  (seconds) does not change outcomes.
- **Keepers are not trusted with outcomes.** Anyone can `poke` a note; the engine decides what is due.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-1 | **High** (latent) | `withdraw` converted base units to the 10-decimal ledger by truncation. For a token with more than 10 decimals (WETH, Robinhood's 18-decimal stock tokens), a withdrawal smaller than 10^(d−10) debited **nothing** while paying out the tokens, so a holder could drain other holders' share of that note's vault in dust withdrawals. | **Fixed**: the amount must convert exactly (`_toBase(_fromBase(base)) == base`) and debit > 0, else `BadInputs`. Fuzzed with an 18-decimal token. The live testnet engines use 6/8/9-decimal test tokens, where the conversion is exact, so they are not exploitable. |
| F-2 | Medium | `deposit()` let any address credit itself a dust amount, taking one of the note's 64 ledger slots (never released). 64 dust deposits would block every later subscription (`HoldingsFull`). | **Fixed**: only an account the note already holds may `deposit`. The app never calls it (payments are funded through workflow steps). Caught by the access-control invariant when the fix is reverted. |
| F-3 | Medium | The same slot exhaustion is possible with dust **subscriptions** or dust **transfers** to fresh addresses. | **Accepted, mitigated**: with `requireEmail` on, every new holder needs a verifier attestation (the API rate-limits verifications). Recommended for v2: a minimum lot in the subscribe step's guard, and reusing slots whose balances are all zero. |
| F-4 | Low | With a workflow id/author/name check configured, `onReport` decoded 62 bytes of metadata even when fewer were sent (reading past its end). The values read could not match, so it failed closed, but by accident. | **Fixed**: shorter metadata reverts `InvalidMetadata`. |
| F-5 | Low | Owner powers (forwarder, fallback reporter, verifier, pause). `setForwarderAddress(0)` accepts reports from anyone (Chainlink's template emits a `SecurityWarning`). | **Accepted by design**; documented. Before mainnet: multisig owner plus timelock. The owner has no path to user funds. |
| F-6 | Info | An asset's decimals come from the definition, not from `token.decimals()`. A mismatch mis-scales amounts for that note only (its ledger stays internally consistent). | **Accepted**; the app builds definitions from the token's own decimals. Recommended for v2: check `decimals()` at `startProcess`. |
| F-7 | Info | Reports keep running while paused. | **By design**: payment dates are honoured and holders can always withdraw. |
| F-8 | Info | Product limits: an issuer can choose to default (holders then recover only the collateral, capped at what they are owed); margin is checked at the strike and at each observation, not continuously; prices are trusted within each field's bounds. | Documented in docs/NOTE-ECONOMICS.md and the app. |

Checklist (all reviewed; findings above where any):
- **Reentrancy:** every state-changing entry point is `nonReentrant`; ERC-20 calls come last (CEI).
- **Access control:** checked on every external function, by role or owner.
- **Forwarder and metadata validation:** as Chainlink's ReceiverTemplate, plus the length check (F-4).
- **Integer bounds and decimal scaling:** 0.8 checked arithmetic, inputs ≤ int128, decimals ≤ 36 (F-1 fixed).
- **Payout rounding:** `_mul` truncates toward zero, so payouts round down and never overdraw escrow.
- **Loops:** bounded by MAX_HOLDERS / MAX_TOKENS / MAX_ADVANCE / MAX_DEPOSITS.
- **Front-running:** a funding window can't be "done" late (`WindowClosed`), and only the engine closes windows.
- **Attestation replay:** the domain includes chainId and the verifying contract, with a per-holder nonce bumped by every attestation and revocation (tested).
- **ERC-20 handling:** SafeERC20, and fee-on-transfer tokens refused by a balance delta check.
- **Pause:** blocks new actions only.
- **SSTORE2:** pointer code starts with STOP, so it can't be called, and has no selfdestruct or delegatecall.
- **Libraries:** external libraries take explicit storage pointers; no storage collisions.

## Static analysis

**Slither 0.11.6** (`slither . --filter-paths "lib/|test/|script/"`) reported 40 results:

| Detector | Count | Triage |
|---|---|---|
| incorrect-equality (`_core`: `id == 0`) | 1 | False positive: an unset sentinel, not a balance |
| uninitialized-local | 7 | False positive: zero-initialised accumulators by intent |
| unused-return (NotesLens) | 3 | False positive: deliberate partial destructuring of the engine's views |
| missing-zero-check | 3 | By design: zero means "off" (fallback reporter, verifier, expected author) |
| calls-loop | 13 | Accepted: NotesLens views are read-only; `_pull` loops ≤ 4 times over the note's own token |
| reentrancy-events (TokenFaucet) | 1 | False positive: test token, minted by the trusted TestToken |
| timestamp | 6 | Accepted: dates are the product; seconds of drift don't matter |
| cyclomatic-complexity / assembly / solc-version / unindexed-event-address | 6 | Informational. Assembly reviewed and annotated `memory-safe`; the solc version is pinned; the event layout is kept for ABI stability |

**Aderyn 0.6.8**:

| Finding | Triage |
|---|---|
| H-1 `abi.encodePacked` collision (SSTORE2) | False positive: it builds creation code and is not hashed |
| H-2 state change after external call (NotesLens.publish) | False positive: a view call to the immutable engine |
| H-3 unsafe casts (FlowEngine) | False positive: each bounded by DefCheck at registration and annotated |
| Lows: centralization, loops, literals, pragma | Documented above, or style |

## Tests

| Suite | What it checks |
|---|---|
| `test/Products.t.sol` (21) | Every product end to end against the reference payoff: funded, missed coupons, cures in grace, half-funded redemption, margin calls cured or not, both default rules, physical delivery, worst-of. Plus escrow custody, closed windows, oracle bounds, roles, pause, two-step ownership, CRE identity checks, email attestation and gating, and gas with 30 and 62 holders. |
| `test/Invariants.t.sol` | **Invariants** on three notes (paid in full; missed coupon → default; mixed collateral → capped default). Each runs **64 runs × 64 calls = 4,096 calls**, with the timeline interleaved with random transfers, withdrawals, deposits, attempts on escrow and stranger reports. The invariants: <ul><li>solvency (the vault covers the ledger; the engine holds its vaults);</li><li>units conserved by transfers and never exceeding issuance;</li><li>escrow only moved by the workflow;</li><li>only the forwarder reports and strangers can't deposit;</li><li>holders never paid more than the reference.</li></ul> **Fuzz** properties, 256 runs each: oracle bounds, exact withdrawals with an 18-decimal token, random subscriptions and transfers, funding only while a window is open, email gating for random addresses, only the forwarder reports. |
| `test/TestTokens.t.sol` (6) | Faucet and test token permissions |

Mutation check: removing the F-2 fix makes `invariant_accessControl` fail at once.

Coverage (`forge coverage --ir-minimum`, unit and fuzz suites):

| File | Lines | Branches | Functions |
|---|---|---|---|
| FlowEngine.sol | 94.7% | 63.1% | 95.1% |
| CreReceiver.sol | 93.9% | 81.8% | 100% |
| EmailAttest.sol | 100% | 100% | 100% |
| Def.sol | 92.7% | 100% | 100% |
| DefCheck.sol | 98.5% | 18.8% (one revert per malformed field; the happy path is covered) | 100% |
| NotesLens.sol | 88.7% | 100% | 71.4% |

Bytecode: FlowEngine **23,384 / 24,576** bytes. Marking the assembly blocks memory-safe saved about 1.1 KB.

## Before mainnet

1. An independent audit of `packages/evm-engine`.
2. Owner = a multisig, with a timelock on the forwarder, fallback-reporter, workflow-identity and verifier setters.
3. Production KeystoneForwarder with the workflow id, author and name checks set.
4. Verifier, fallback reporter and keeper keys in a KMS or HSM, not files.
5. F-3 hardening (a minimum lot, and reusing empty ledger slots), and an on-chain decimals check (F-6).
6. Real stablecoins and stock tokens, re-tested with their actual decimals.
