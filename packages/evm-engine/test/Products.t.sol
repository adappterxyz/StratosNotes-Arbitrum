// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {NotesLens} from "../src/NotesLens.sol";
import {CreReceiver} from "../src/cre/CreReceiver.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";
import {Def} from "../src/lib/Def.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// Every structured product run end to end on the engine, with the issuer in the loop: the issuer starts the
/// note and pledges collateral into escrow at Approve Terms; investors subscribe from the open book (their
/// stablecoin goes to the issuer); the strike and every observation arrive as forwarder-delivered CRE reports;
/// the issuer funds each payment (early, in parts, late within grace, partly, or not at all) and tops up margin
/// calls (or not); a keeper advances due timers. Each holder's cash, delivered tokens and collateral received,
/// the issuer's released collateral and the paying agent's fees must equal the REFERENCE model
/// (fixtures: scripts/fixtures.ts, from packages/core payoff.ts).
contract ProductsTest is Test {
    struct Pledge {
        uint8 token;
        uint256 base;
    }

    struct Action {
        uint8 kind; // 1 report, 2 advance (keeper), 3 issuer step (fund / top up), 4 transfer
        uint64 at;
        uint16 step;
        uint8 token;
        uint256 base;
        FlowEngine.Input[] inputs;
        int256[] values;
    }

    struct Fixture {
        string name;
        bytes def;
        uint8[] tokenOf;
        uint16 startStep;
        uint16 approveStep;
        uint16 mandateStep;
        uint16 subscribeStep;
        uint16 fixStrikeStep;
        FlowEngine.Input[] approveInputs;
        Pledge[] pledges;
        int256[] investorUnits;
        uint256[] investorCash;
        int256 transferUnits;
        Action[] actions;
        int256[][] expected;
        int256[] issuerCollateral;
        int256 issuerProceeds;
        int256 paFee;
        bool defaulted;
        uint64 strikeAt;
    }

    uint16 constant NO = 0xFFFF; // no XOR choice (a local constant: an engine call would consume vm.expectRevert)
    uint8 constant NOTE = 0;
    uint8 constant CASH = 1;
    int256 constant SCALE = 1e10;
    /// The hackathon's tolerance: 6 decimal places of a unit (reference payoff in floating point).
    int256 constant TOLERANCE = 5_000;
    bytes32 constant MILESTONE = keccak256("Milestone(uint256,uint8,uint16,address)");

    FlowEngine engine;
    address forwarder = makeAddr("forwarder");
    address admin = makeAddr("admin");
    MockERC20[5] tokens; // 1 tUSD, 2 tETH, 3 tBTC, 4 tSOL
    uint8[5] decimals = [0, 6, 9, 8, 9];
    uint256 t0;
    bytes[] fixtures;
    uint256 maxReportGas;
    uint256 maxSubscribeGas;
    uint256 maxFundGas;
    uint256[] reportGas; // every report and advance in the last replay, in order

    function setUp() public {
        engine = new FlowEngine(admin, forwarder);
        tokens[1] = new MockERC20("tUSD", 6);
        tokens[2] = new MockERC20("tETH", 9);
        tokens[3] = new MockERC20("tBTC", 8);
        tokens[4] = new MockERC20("tSOL", 9);
        string memory json = vm.readFile("test/fixtures/products.json");
        t0 = vm.parseJsonUint(json, ".t0");
        bytes[] memory runs = vm.parseJsonBytesArray(json, ".runs");
        for (uint256 i = 0; i < runs.length; i++) fixtures.push(runs[i]);
    }

    function _fixture(uint256 i) internal view returns (Fixture memory) {
        return abi.decode(fixtures[i], (Fixture));
    }

    function _num(int256 v) internal pure returns (FlowEngine.Input[] memory a) {
        a = new FlowEngine.Input[](1);
        a[0] = FlowEngine.Input(1, bytes32(uint256(v)));
    }

    function _none() internal pure returns (FlowEngine.Input[] memory) {
        return new FlowEngine.Input[](0);
    }

    function _report(uint256 pid, uint16 step, int256[] memory values) internal returns (uint256 gasUsed) {
        vm.prank(forwarder);
        uint256 g = gasleft();
        engine.onReport("", abi.encode(pid, step, values));
        gasUsed = g - gasleft();
        if (gasUsed > maxReportGas) maxReportGas = gasUsed;
    }

    function _subscribe(Fixture memory f, uint256 pid, address who, int256 units, uint256 cash) internal {
        tokens[1].mint(who, cash);
        vm.startPrank(who);
        tokens[1].approve(address(engine), cash);
        uint256 g = gasleft();
        engine.executeStep(pid, f.subscribeStep, NO, _num(units));
        uint256 used = g - gasleft();
        vm.stopPrank();
        if (used > maxSubscribeGas) maxSubscribeGas = used;
    }

    function _roles(address issuer, address pa) internal pure returns (address[] memory roles) {
        roles = new address[](4); // Issuer, Paying Agent, Investor (open), Escrow (the engine's)
        roles[0] = issuer;
        roles[1] = pa;
    }

    function _assetTokens(Fixture memory f) internal view returns (address[] memory assetTokens) {
        assetTokens = new address[](f.tokenOf.length);
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            if (f.tokenOf[a] != 0) assetTokens[a] = address(tokens[f.tokenOf[a]]);
        }
    }

    /// Issue: register, start, pre-trade terms with the collateral pledged into escrow, mandate.
    function _issue(Fixture memory f, address issuer, address pa) internal returns (uint256 pid) {
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        assertEq(id, sha256(f.def), "definition id = sha256(bytes)");
        vm.prank(issuer);
        pid = engine.startProcess(id, 1, _roles(issuer, pa), _assetTokens(f), f.startStep, _none());
        vm.startPrank(issuer);
        for (uint256 t = 1; t < 5; t++) tokens[t].approve(address(engine), type(uint256).max);
        for (uint256 k = 0; k < f.pledges.length; k++) tokens[f.pledges[k].token].mint(issuer, f.pledges[k].base);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
    }

    /// Replay the timeline: CRE reports, keeper advances, the issuer's funding and top-ups, a transfer.
    function _play(Fixture memory f, uint256 pid, address issuer, address[] memory holders, uint256 from, uint256 until) internal {
        for (uint256 i = from; i < until && i < f.actions.length; i++) {
            Action memory a = f.actions[i];
            if (a.at > block.timestamp) vm.warp(a.at);
            if (a.kind == 1) {
                reportGas.push(_report(pid, a.step, a.values));
            } else if (a.kind == 2) {
                reportGas.push(_report(pid, NO, new int256[](0)));
            } else if (a.kind == 3) {
                tokens[a.token].mint(issuer, a.base);
                vm.prank(issuer);
                uint256 g = gasleft();
                engine.executeStep(pid, a.step, NO, a.inputs);
                uint256 used = g - gasleft();
                if (used > maxFundGas) maxFundGas = used;
            } else if (a.kind == 4) {
                // Secondary transfer, in part: later payments (and a default's collateral) follow the units.
                address buyer = holders[holders.length - 1];
                int256 amount = int256(uint256(a.inputs[0].data));
                address escrow = engine.ESCROW(); // read first: an engine call would consume vm.expectRevert
                vm.startPrank(holders[0]);
                vm.expectRevert(FlowEngine.NotTransferable.selector);
                engine.transferUnits(pid, CASH, buyer, 1);
                vm.expectRevert(FlowEngine.BadInputs.selector);
                engine.transferUnits(pid, NOTE, escrow, 1);
                engine.transferUnits(pid, NOTE, buyer, amount);
                vm.stopPrank();
            }
        }
    }

    function _holders(Fixture memory f, uint256 idx) internal returns (address[] memory holders) {
        holders = new address[](f.expected.length);
        for (uint256 k = 0; k < f.investorUnits.length; k++) {
            holders[k] = makeAddr(string.concat("investor", vm.toString(idx), "_", vm.toString(k)));
        }
        if (f.transferUnits > 0) holders[holders.length - 1] = makeAddr(string.concat("buyer", vm.toString(idx)));
    }

    function _runFixture(uint256 idx) internal {
        Fixture memory f = _fixture(idx);
        address issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        address pa = makeAddr(string.concat("pa", vm.toString(idx)));
        uint256 pid = _issue(f, issuer, pa);
        address escrow = engine.ESCROW();
        address[] memory holders = _holders(f, idx);
        for (uint256 k = 0; k < f.investorUnits.length; k++) _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);

        // The subscriptions are the issuer's, at once: it withdraws them before the strike.
        assertApproxEqAbs(engine.balanceOf(pid, issuer, CASH), f.issuerProceeds, uint256(TOLERANCE), string.concat(f.name, ": proceeds"));
        uint256 proceeds = uint256(f.issuerProceeds * 1e6 / SCALE);
        vm.prank(issuer);
        engine.withdraw(pid, CASH, proceeds);
        // ...but not the pledged collateral, which sits in escrow.
        for (uint8 a = CASH + 1; a < f.tokenOf.length; a++) {
            assertEq(engine.balanceOf(pid, issuer, a), 0, "pledged collateral leaves the issuer's account");
        }

        vm.recordLogs();
        _play(f, pid, issuer, holders, 0, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool defaulted;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == MILESTONE && uint256(logs[i].topics[2]) == 8) defaulted = true;
        }

        assertEq(engine.processOf(pid).status, engine.COMPLETED(), string.concat(f.name, ": completed"));
        assertEq(defaulted, f.defaulted, string.concat(f.name, ": default milestone"));
        assertApproxEqAbs(engine.balanceOf(pid, pa, CASH), f.paFee, uint256(TOLERANCE), string.concat(f.name, ": paying agent fees"));
        for (uint256 k = 0; k < holders.length; k++) {
            for (uint8 a = CASH; a < f.tokenOf.length; a++) {
                int256 got = engine.balanceOf(pid, holders[k], a);
                assertApproxEqAbs(got, f.expected[k][a], uint256(TOLERANCE), string.concat(f.name, ": holder ", vm.toString(k), " asset ", vm.toString(a)));
                // Withdrawn as the ERC-20 (cash, delivered tokens, collateral received on a default).
                uint256 d = decimals[f.tokenOf[a]];
                uint256 base = uint256(got * int256(10 ** d) / SCALE);
                if (base > 0) {
                    uint256 before = tokens[f.tokenOf[a]].balanceOf(holders[k]);
                    vm.prank(holders[k]);
                    engine.withdraw(pid, a, base);
                    assertEq(tokens[f.tokenOf[a]].balanceOf(holders[k]) - before, base, string.concat(f.name, ": withdrawn"));
                }
            }
        }
        // Escrow is empty at the end: released to the issuer, or distributed on a default.
        for (uint8 a = CASH; a < f.tokenOf.length; a++) {
            assertLt(engine.balanceOf(pid, escrow, a), 1e5, string.concat(f.name, ": escrow emptied")); // dust < 0.00001
            if (f.issuerCollateral[a] != 0 || f.defaulted) {
                assertApproxEqAbs(engine.balanceOf(pid, issuer, a), f.issuerCollateral[a], uint256(TOLERANCE), string.concat(f.name, ": collateral back to the issuer"));
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------

    function test_everyProductPaysItsReferencePayoff() public {
        assertGt(fixtures.length, 18);
        for (uint256 i = 0; i < fixtures.length; i++) {
            _runFixture(i);
        }
        console2.log("runs", fixtures.length);
        console2.log("max report gas", maxReportGas);
        console2.log("max subscribe gas", maxSubscribeGas);
        console2.log("max issuer funding/top-up gas", maxFundGas);
        assertLt(maxReportGas, 3_000_000, "every report stays under a 3M gas budget");
    }

    function test_lateSubscriptionRejectedAfterTheBookCloses() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        _subscribe(f, pid, makeAddr("early"), 100e10, 100e6);
        vm.warp(f.strikeAt);
        _report(pid, f.fixStrikeStep, f.actions[0].values);
        address late = makeAddr("late");
        tokens[1].mint(late, 100e6);
        vm.startPrank(late);
        tokens[1].approve(address(engine), 100e6);
        vm.expectRevert(FlowEngine.StepNotActive.selector);
        engine.executeStep(pid, f.subscribeStep, NO, _num(100e10));
        vm.stopPrank();
    }

    /// A person acting in a window after it closed is refused (a late funding call must not look done); only
    /// the engine itself (poke, a report) passes the token on.
    function test_closedWindowRefusesPeopleButClosesByItself() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        _subscribe(f, pid, makeAddr("early"), 100e10, 100e6);
        vm.warp(f.strikeAt); // the book's window closes at the strike, before any report
        address late = makeAddr("late");
        tokens[1].mint(late, 100e6);
        vm.startPrank(late);
        tokens[1].approve(address(engine), 100e6);
        vm.expectRevert(FlowEngine.WindowClosed.selector);
        engine.executeStep(pid, f.subscribeStep, NO, _num(100e10));
        vm.stopPrank();
        assertEq(tokens[1].balanceOf(late), 100e6, "nothing taken");
        engine.poke(pid);
        vm.expectRevert(FlowEngine.StepNotActive.selector);
        vm.prank(late);
        engine.executeStep(pid, f.subscribeStep, NO, _num(100e10));
    }

    /// Escrow: nobody may claim it at the start, nobody signs for it, its balances never leave but by the workflow.
    function test_escrowIsHeldByTheEngine() public {
        Fixture memory f = _fixture(1);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        address issuer = makeAddr("i");
        address[] memory roles = _roles(issuer, makeAddr("p"));
        roles[3] = issuer; // the issuer tries to hold the escrow role itself
        vm.prank(issuer);
        vm.expectRevert(FlowEngine.BadInputs.selector);
        engine.startProcess(id, 1, roles, _assetTokens(f), f.startStep, _none());

        uint256 pid = _issue(f, issuer, makeAddr("p"));
        address escrow = engine.ESCROW();
        assertEq(engine.roleOf(pid, 3), escrow);
        assertGt(engine.balanceOf(pid, escrow, 2), 0, "the pledge sits in escrow"); // col_USD
        vm.prank(issuer);
        vm.expectRevert(FlowEngine.InsufficientBalance.selector);
        engine.withdraw(pid, 2, 1);
        // Funding a payment moves stablecoin into escrow: the issuer cannot take it back either.
        tokens[1].mint(issuer, 50e6);
        vm.prank(issuer);
        engine.executeStep(pid, f.actions[1].step, NO, _num(50e10)); // Fund Payment 1
        assertEq(engine.balanceOf(pid, escrow, CASH), 50e10);
        vm.prank(issuer);
        vm.expectRevert(FlowEngine.InsufficientBalance.selector);
        engine.withdraw(pid, CASH, 1);
    }

    /// The terms are checked on-chain: a grace period above 7 days (or a payment deadline after the next
    /// observation) refuses the whole Approve Terms transaction.
    function test_termsOutOfRangeAreRefused() public {
        Fixture memory f = _fixture(1);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        address issuer = makeAddr("i");
        vm.prank(issuer);
        uint256 pid = engine.startProcess(id, 1, _roles(issuer, makeAddr("p")), _assetTokens(f), f.startStep, _none());
        vm.startPrank(issuer);
        tokens[1].approve(address(engine), type(uint256).max);
        tokens[1].mint(issuer, 10_000e6);
        FlowEngine.Input[] memory bad = f.approveInputs;
        // Inputs: isin, notional, strikeDate, obsDate1..4, lag, grace, ... (fixtures.ts order).
        bad[8] = FlowEngine.Input(1, bytes32(uint256(8 days)));
        vm.expectRevert(FlowEngine.GuardNotMet.selector);
        engine.executeStep(pid, f.approveStep, NO, bad);
        bad[8] = FlowEngine.Input(1, bytes32(uint256(7 days))); // in range, but deadline 1 now passes observation 2
        vm.expectRevert(FlowEngine.GuardNotMet.selector);
        engine.executeStep(pid, f.approveStep, NO, bad);
        vm.stopPrank();
    }

    function test_reportsOnlyFromTheForwarder() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        vm.warp(f.strikeAt);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, stranger, forwarder));
        engine.onReport("", abi.encode(pid, f.fixStrikeStep, f.actions[0].values));
    }

    /// The lens: full definition bytes (CORE and META) for keepers, and running processes' state in one call.
    function test_lensPublishesDefinitionsAndListsRunningProcesses() public {
        NotesLens lens = new NotesLens(engine);
        Fixture memory f = _fixture(0);
        vm.expectRevert(NotesLens.NotRegistered.selector);
        lens.publish(f.def);

        address i1 = makeAddr("i1");
        uint256 a = _issue(f, i1, makeAddr("p1"));
        Fixture memory g = _fixture(7); // the worst-of: a second definition
        uint256 b = _issue(g, makeAddr("i2"), makeAddr("p2"));
        bytes32 id = lens.publish(f.def);
        assertEq(id, sha256(f.def));
        assertEq(lens.publish(f.def), id, "idempotent");
        assertEq(keccak256(lens.definitionBytes(id)), keccak256(f.def), "bytes round-trip");
        assertEq(lens.definitionBytes(bytes32(uint256(1))).length, 0);

        // Balances: every role's account, every asset (escrow included).
        NotesLens.Snapshot memory sa = lens.snapshot(a);
        assertEq(sa.balances.length, 4 * f.tokenOf.length);
        assertGt(sa.balances[3 * f.tokenOf.length + 2], 0, "the escrow's pledged collateral");

        // Finish the first note: only the second is listed.
        address[] memory holders = new address[](1);
        holders[0] = makeAddr("x");
        _subscribe(f, a, holders[0], 1000e10, 1000e6);
        _play(f, a, i1, holders, 0, type(uint256).max);
        assertEq(engine.processOf(a).status, engine.COMPLETED());
        (NotesLens.Snapshot[] memory s, uint256 next) = lens.running(0, 100, 10);
        assertEq(s.length, 1);
        assertEq(next, 0, "scanned to the end");
        assertEq(s[0].pid, b);
        assertEq(s[0].definition, sha256(g.def));
        assertEq(s[0].status, 0);
        assertEq(s[0].tokens.length, engine.tokensOf(b).length);
        assertGt(s[0].values.length, 0, "pre-trade terms are captured");

        // Paging: one pid at a time.
        (s, next) = lens.running(1, 1, 10);
        assertEq(s.length, 0);
        assertEq(next, 2);
    }

    /// The fallback reporter is off until the owner sets it; its reports are recorded with its address.
    function test_fallbackReporterIsOffByDefaultAndRecorded() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        vm.warp(f.strikeAt);
        bytes memory report = abi.encode(pid, f.fixStrikeStep, f.actions[0].values);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, keeper, address(0)));
        engine.fallbackReport(report);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", keeper));
        engine.setFallbackReporter(keeper);
        vm.prank(admin);
        engine.setFallbackReporter(keeper);

        vm.expectEmit(true, true, false, true, address(engine));
        emit FlowEngine.ReportProcessed(pid, f.fixStrikeStep, f.actions[0].values, keeper);
        vm.prank(keeper);
        engine.fallbackReport(report);

        // Turned off again: refused.
        vm.prank(admin);
        engine.setFallbackReporter(address(0));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, keeper, address(0)));
        engine.fallbackReport(abi.encode(pid, uint16(0xFFFF), new int256[](0)));
    }

    function test_oracleValuesAreBoundsChecked() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        vm.warp(f.strikeAt);
        int256[] memory crazy = new int256[](1);
        crazy[0] = 2_000_000 * SCALE; // ETH bounds are 1 .. 1,000,000
        vm.prank(forwarder);
        vm.expectRevert(FlowEngine.OracleOutOfBounds.selector);
        engine.onReport("", abi.encode(pid, f.fixStrikeStep, crazy));
    }

    function test_oracleStepsCannotBeRunByHand() public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("i");
        uint256 pid = _issue(f, issuer, makeAddr("p"));
        vm.warp(f.strikeAt);
        vm.prank(issuer);
        vm.expectRevert(FlowEngine.OracleOnlyViaReport.selector);
        engine.executeStep(pid, f.fixStrikeStep, NO, _none());
    }

    function test_onlyTheRoleHolderActs() public {
        Fixture memory f = _fixture(0);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        address issuer = makeAddr("i");
        address[] memory roles = _roles(issuer, makeAddr("p"));
        vm.prank(makeAddr("impostor"));
        vm.expectRevert(FlowEngine.WrongRole.selector);
        engine.startProcess(id, 1, roles, _assetTokens(f), f.startStep, _none());
        vm.prank(issuer);
        uint256 pid = engine.startProcess(id, 1, roles, _assetTokens(f), f.startStep, _none());
        vm.prank(makeAddr("impostor"));
        vm.expectRevert(FlowEngine.WrongRole.selector);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
    }

    function test_definitionsAreContentAddressedAndChecked() public {
        Fixture memory f = _fixture(0);
        bytes32 id = engine.registerDefinition(f.def);
        assertEq(engine.registerDefinition(f.def), id, "idempotent");
        (address pointer, uint32 coreLen,) = engine.definitionOf(id);
        assertTrue(pointer != address(0));
        assertEq(keccak256(engine.definitionCore(id)), keccak256(_slice(f.def, 0, coreLen)));
        // A step pointing at a role that does not exist is refused.
        bytes memory bad = bytes.concat(f.def);
        uint256 tables = 12 + uint256(uint8(bad[1])) + uint256(uint8(bad[2])) + 2 * uint256(uint8(bad[3])) + 2 * _u16(bad, 4);
        uint256 so = _u16(bad, tables);
        bad[so + 1] = bytes1(uint8(7));
        vm.expectRevert(Def.BadDefinition.selector);
        engine.registerDefinition(bad);
        // A step acting as the escrow role is refused too: nobody signs for escrow.
        bad = bytes.concat(f.def);
        bad[so + 1] = bytes1(uint8(3));
        vm.expectRevert(Def.BadDefinition.selector);
        engine.registerDefinition(bad);
    }

    function test_feeOnTransferTokensAreRefused() public {
        Fixture memory f = _fixture(0);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        FeeOnTransferERC20 fee = new FeeOnTransferERC20();
        address issuer = makeAddr("i");
        address[] memory assetTokens = _assetTokens(f);
        for (uint256 a = 1; a < assetTokens.length; a++) assetTokens[a] = address(fee);
        vm.startPrank(issuer);
        uint256 pid = engine.startProcess(id, 1, _roles(issuer, makeAddr("p")), assetTokens, f.startStep, _none());
        fee.mint(issuer, 1_000_000e6);
        fee.approve(address(engine), type(uint256).max);
        vm.expectRevert(FlowEngine.TransferMismatch.selector);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs); // the collateral pledge pulls the token
        vm.stopPrank();
    }

    function test_payoutReportsAreReservedForCrossChain() public {
        vm.prank(forwarder);
        vm.expectRevert(FlowEngine.PayoutsNotSupported.selector);
        engine.onReport("", abi.encode(uint256(1), uint16(0xFFFE), new int256[](0)));
    }

    function test_supportsTheReceiverInterface() public view {
        assertTrue(engine.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(engine.supportsInterface(type(IERC165).interfaceId));
        assertFalse(engine.supportsInterface(0xdeadbeef));
    }

    function test_pauseStopsActionsButNotWithdrawalsOrReports() public {
        Fixture memory f = _fixture(0); // FCN, autocalled at observation 2
        address issuer = makeAddr("i");
        uint256 pid = _issue(f, issuer, makeAddr("p"));
        address inv = makeAddr("inv");
        _subscribe(f, pid, inv, 1000e10, 1000e6);
        vm.prank(admin);
        engine.pause();
        address late = makeAddr("late");
        tokens[1].mint(late, 1e6);
        vm.startPrank(late);
        tokens[1].approve(address(engine), 1e6);
        vm.expectRevert(); // EnforcedPause
        engine.executeStep(pid, f.subscribeStep, NO, _num(1e10));
        vm.stopPrank();
        address[] memory holders = new address[](1);
        holders[0] = inv;
        _play(f, pid, issuer, holders, 0, 1); // the strike report still lands while paused
        vm.prank(admin);
        engine.unpause(); // the issuer funds payments with steps, so unpause before the payments
        _play(f, pid, issuer, holders, 1, type(uint256).max);
        assertEq(engine.processOf(pid).status, engine.COMPLETED());
        vm.prank(admin);
        engine.pause();
        uint256 base = uint256(engine.balanceOf(pid, inv, CASH) * 1e6 / SCALE);
        vm.prank(inv);
        engine.withdraw(pid, CASH, base);
        assertEq(tokens[1].balanceOf(inv), base);
    }

    function test_ownershipIsTwoStep() public {
        address next = makeAddr("next");
        vm.prank(admin);
        engine.transferOwnership(next);
        assertEq(engine.owner(), admin);
        vm.prank(next);
        engine.acceptOwnership();
        assertEq(engine.owner(), next);
    }

    /// Gas with a full book: 30 investors, then the cap of 64 ledger accounts (62 investors + issuer + escrow).
    function test_gasWithManyHolders() public {
        _manyHolders(30, "30", 18);
        _manyHolders(62, "62", 18);
        _manyHolders(30, "30 all-to-holders", 19);
        _manyHolders(62, "62 all-to-holders", 19);
    }

    function _manyHolders(uint256 n, string memory label, uint256 fixtureIdx) internal {
        // FCN with USDC + ETH collateral; the issuer funds coupon 1, misses coupon 2 (fixture 18, default rule
        // cap-at-owed; 19, all-to-holders): the issuer's funding, a coupon paid to every holder, margin checks on
        // the ETH collateral, and the heaviest default (cash, USDC and ETH collateral distributed to every holder).
        Fixture memory f = _fixture(fixtureIdx);
        address issuer = makeAddr(string.concat("I", label));
        uint256 pid = _issue(f, issuer, makeAddr(string.concat("P", label)));
        int256 units = int256(1000 / n) * SCALE;
        address[] memory holders = new address[](n);
        for (uint256 k = 0; k < n; k++) {
            holders[k] = makeAddr(string.concat("h", label, "_", vm.toString(k)));
            _subscribe(f, pid, holders[k], units, uint256(units / SCALE) * 1e6);
        }
        uint256 reportBefore = maxReportGas;
        maxReportGas = 0;
        maxFundGas = 0;
        delete reportGas;
        _play(f, pid, issuer, holders, 0, type(uint256).max);
        assertEq(engine.processOf(pid).status, engine.COMPLETED());
        // Reports in order: strike, observation 1, payment date 1 (pays every holder), observation 2,
        // payment date 2 (missed), grace end (default).
        console2.log(string.concat("holders ", label, ": strike (with margin check) gas"), reportGas[0]);
        console2.log(string.concat("holders ", label, ": observation (with margin check) gas"), reportGas[1]);
        console2.log(string.concat("holders ", label, ": coupon paid to every holder gas"), reportGas[2]);
        console2.log(string.concat("holders ", label, ": default, escrow to every holder gas"), reportGas[reportGas.length - 1]);
        console2.log(string.concat("holders ", label, ": issuer funding a payment gas"), maxFundGas);
        assertLt(maxReportGas, 10_000_000, "stays under CRE's 10M write gas");
        maxReportGas = reportBefore > maxReportGas ? reportBefore : maxReportGas;
    }

    // ---------------------------------------------------------------------------------------------------------

    function _u16(bytes memory b, uint256 o) internal pure returns (uint256) {
        return (uint256(uint8(b[o])) << 8) | uint8(b[o + 1]);
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i = from; i < to; i++) out[i - from] = b[i];
    }
}
