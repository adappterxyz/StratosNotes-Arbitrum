// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {NotesLens} from "../src/NotesLens.sol";
import {CreReceiver} from "../src/cre/CreReceiver.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";
import {Def} from "../src/lib/Def.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// Every structured product run end to end on the engine: the issuer starts the note, fixes the pre-trade terms
/// and deposits the coupon reserve (and, for physical settlement, a delivery reserve), investors subscribe from
/// the open book, the strike and every observation arrive as forwarder-delivered CRE reports, and each holder's
/// payout must equal the reference payoff (fixtures: scripts/fixtures.ts).
contract ProductsTest is Test {
    struct Reserve {
        uint16 step;
        uint8 asset;
        uint8 token;
        int256 amount;
        uint256 base;
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
        uint16[] observeSteps;
        FlowEngine.Input[] approveInputs;
        uint256 issuerCash;
        Reserve[] reserves;
        int256[] investorUnits;
        uint256[] investorCash;
        int256[] strikes;
        int256[][] obs;
        int256 transferUnits;
        int256[] expectedCash;
        int256[] expectedDelivered;
        uint8 deliveredAsset;
        int256 paFee;
        uint64 strikeAt;
        uint64[] obsAt;
    }

    uint16 constant NO = 0xFFFF; // no XOR choice (a local constant: an engine call would consume vm.expectRevert)
    uint8 constant NOTE = 0;
    uint8 constant CASH = 1;
    int256 constant SCALE = 1e10;
    /// The hackathon's tolerance: 6 decimal places of a unit (reference payoff in floating point).
    int256 constant TOLERANCE = 5_000;

    FlowEngine engine;
    address forwarder = makeAddr("forwarder");
    address admin = makeAddr("admin");
    MockERC20[5] tokens; // 1 USDC, 2 tETH, 3 tBTC, 4 tSOL
    uint256 t0;
    bytes[] fixtures;
    uint256 maxReportGas;
    uint256 maxSubscribeGas;

    function setUp() public {
        engine = new FlowEngine(admin, forwarder);
        tokens[1] = new MockERC20("USDC", 6);
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

    /// Issue: register, start, pre-trade terms with the coupon reserve, delivery reserves, mandate.
    function _issue(Fixture memory f, address issuer, address pa) internal returns (uint256 pid) {
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        assertEq(id, sha256(f.def), "definition id = sha256(bytes)");
        address[] memory roles = new address[](3);
        roles[0] = issuer;
        roles[1] = pa;
        address[] memory assetTokens = new address[](f.tokenOf.length);
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            if (f.tokenOf[a] != 0) assetTokens[a] = address(tokens[f.tokenOf[a]]);
        }
        vm.prank(issuer);
        pid = engine.startProcess(id, 1, roles, assetTokens, f.startStep, _none());

        tokens[1].mint(issuer, f.issuerCash);
        vm.startPrank(issuer);
        tokens[1].approve(address(engine), type(uint256).max);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        for (uint256 k = 0; k < f.reserves.length; k++) {
            Reserve memory rs = f.reserves[k];
            tokens[rs.token].mint(issuer, rs.base);
            tokens[rs.token].approve(address(engine), rs.base);
            engine.executeStep(pid, rs.step, NO, _num(rs.amount));
        }
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
    }

    function _observe(Fixture memory f, uint256 pid) internal {
        vm.warp(f.strikeAt);
        _report(pid, f.fixStrikeStep, f.strikes);
    }

    function _runObservations(Fixture memory f, uint256 pid) internal {
        for (uint256 k = 0; k < f.observeSteps.length; k++) {
            if (engine.processOf(pid).status != engine.RUNNING()) break; // autocalled
            vm.warp(f.obsAt[k]);
            _report(pid, f.observeSteps[k], f.obs[k]);
        }
    }

    function _runFixture(uint256 idx) internal {
        Fixture memory f = _fixture(idx);
        address issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        address pa = makeAddr(string.concat("pa", vm.toString(idx)));
        uint256 pid = _issue(f, issuer, pa);

        address[] memory holders = new address[](f.expectedCash.length);
        for (uint256 k = 0; k < f.investorUnits.length; k++) {
            holders[k] = makeAddr(string.concat("investor", vm.toString(idx), "_", vm.toString(k)));
            _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);
        }

        _observe(f, pid);
        // Secondary transfer, in part: later coupons and the redemption follow the units.
        if (f.transferUnits > 0) {
            address buyer = makeAddr(string.concat("buyer", vm.toString(idx)));
            holders[holders.length - 1] = buyer;
            vm.startPrank(holders[0]);
            vm.expectRevert(FlowEngine.NotTransferable.selector);
            engine.transferUnits(pid, CASH, buyer, 1);
            vm.expectRevert(FlowEngine.InsufficientBalance.selector);
            engine.transferUnits(pid, NOTE, buyer, f.investorUnits[0] + 1);
            engine.transferUnits(pid, NOTE, buyer, f.transferUnits);
            vm.stopPrank();
        }
        _runObservations(f, pid);

        assertEq(engine.processOf(pid).status, engine.COMPLETED(), string.concat(f.name, ": completed"));
        assertApproxEqAbs(engine.balanceOf(pid, pa, CASH), f.paFee, uint256(TOLERANCE), string.concat(f.name, ": paying agent fees"));
        for (uint256 k = 0; k < holders.length; k++) {
            int256 owed = engine.balanceOf(pid, holders[k], CASH);
            assertApproxEqAbs(owed, f.expectedCash[k], uint256(TOLERANCE), string.concat(f.name, ": holder ", vm.toString(k), " cash"));
            for (uint8 a = CASH + 1; a < f.tokenOf.length; a++) {
                int256 want = (f.expectedDelivered[k] != 0 && a == f.deliveredAsset) ? f.expectedDelivered[k] : int256(0);
                assertApproxEqAbs(engine.balanceOf(pid, holders[k], a), want, uint256(TOLERANCE), string.concat(f.name, ": holder ", vm.toString(k), " delivered"));
            }
            // Withdrawn as the ERC-20.
            uint256 base = uint256(owed * 1e6 / SCALE);
            if (base > 0) {
                vm.prank(holders[k]);
                engine.withdraw(pid, CASH, base);
            }
            assertEq(tokens[1].balanceOf(holders[k]), base, string.concat(f.name, ": withdrawn"));
        }
    }

    // ---------------------------------------------------------------------------------------------------------

    function test_everyProductPaysItsReferencePayoff() public {
        assertGt(fixtures.length, 12);
        for (uint256 i = 0; i < fixtures.length; i++) {
            _runFixture(i);
        }
        console2.log("runs", fixtures.length);
        console2.log("max report gas", maxReportGas);
        console2.log("max subscribe gas", maxSubscribeGas);
        assertLt(maxReportGas, 3_000_000, "every report stays under a 3M gas budget");
    }

    function test_lateSubscriptionRejectedAfterTheBookCloses() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        _subscribe(f, pid, makeAddr("early"), 100e10, 100e6);
        _observe(f, pid);
        address late = makeAddr("late");
        tokens[1].mint(late, 100e6);
        vm.startPrank(late);
        tokens[1].approve(address(engine), 100e6);
        vm.expectRevert(FlowEngine.StepNotActive.selector);
        engine.executeStep(pid, f.subscribeStep, NO, _num(100e10));
        vm.stopPrank();
    }

    function test_reportsOnlyFromTheForwarder() public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        vm.warp(f.strikeAt);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, stranger, forwarder));
        engine.onReport("", abi.encode(pid, f.fixStrikeStep, f.strikes));
    }

    /// The lens: full definition bytes (CORE and META) for keepers, and running processes' state in one call.
    function test_lensPublishesDefinitionsAndListsRunningProcesses() public {
        NotesLens lens = new NotesLens(engine);
        Fixture memory f = _fixture(0);
        vm.expectRevert(NotesLens.NotRegistered.selector);
        lens.publish(f.def);

        uint256 a = _issue(f, makeAddr("i1"), makeAddr("p1"));
        Fixture memory g = _fixture(7); // the worst-of: a second definition
        uint256 b = _issue(g, makeAddr("i2"), makeAddr("p2"));
        bytes32 id = lens.publish(f.def);
        assertEq(id, sha256(f.def));
        assertEq(lens.publish(f.def), id, "idempotent");
        assertEq(keccak256(lens.definitionBytes(id)), keccak256(f.def), "bytes round-trip");
        assertEq(lens.definitionBytes(bytes32(uint256(1))).length, 0);

        // Finish the first note: only the second is listed.
        _subscribe(f, a, makeAddr("x"), 100e10, 100e6);
        _observe(f, a);
        _runObservations(f, a);
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
        bytes memory report = abi.encode(pid, f.fixStrikeStep, f.strikes);
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
        emit FlowEngine.ReportProcessed(pid, f.fixStrikeStep, f.strikes, keeper);
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
        address[] memory roles = new address[](3);
        roles[0] = issuer;
        roles[1] = makeAddr("p");
        address[] memory assetTokens = new address[](2);
        assetTokens[1] = address(tokens[1]);
        vm.prank(makeAddr("impostor"));
        vm.expectRevert(FlowEngine.WrongRole.selector);
        engine.startProcess(id, 1, roles, assetTokens, f.startStep, _none());
        vm.prank(issuer);
        uint256 pid = engine.startProcess(id, 1, roles, assetTokens, f.startStep, _none());
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
        uint256 so = _u16(bad, 12 + uint256(uint8(bad[2])) + 2 * uint256(uint8(bad[3])) + 2 * _u16(bad, 4));
        bad[so + 1] = bytes1(uint8(7));
        vm.expectRevert(Def.BadDefinition.selector);
        engine.registerDefinition(bad);
    }

    function test_feeOnTransferTokensAreRefused() public {
        Fixture memory f = _fixture(0);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        FeeOnTransferERC20 fee = new FeeOnTransferERC20();
        address issuer = makeAddr("i");
        address[] memory roles = new address[](3);
        roles[0] = issuer;
        roles[1] = makeAddr("p");
        address[] memory assetTokens = new address[](2);
        assetTokens[1] = address(fee);
        vm.startPrank(issuer);
        uint256 pid = engine.startProcess(id, 1, roles, assetTokens, f.startStep, _none());
        fee.mint(issuer, f.issuerCash * 2);
        fee.approve(address(engine), type(uint256).max);
        vm.expectRevert(FlowEngine.TransferMismatch.selector);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
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
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        address inv = makeAddr("inv");
        _subscribe(f, pid, inv, 100e10, 100e6);
        vm.prank(admin);
        engine.pause();
        address late = makeAddr("late");
        tokens[1].mint(late, 1e6);
        vm.startPrank(late);
        tokens[1].approve(address(engine), 1e6);
        vm.expectRevert(); // EnforcedPause
        engine.executeStep(pid, f.subscribeStep, NO, _num(1e10));
        vm.stopPrank();
        _observe(f, pid);
        _runObservations(f, pid);
        assertEq(engine.processOf(pid).status, engine.COMPLETED());
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

    /// Gas with a full book: 30 investors, then the cap of 64 ledger accounts.
    function test_gasWithManyHolders() public {
        _manyHolders(30, "30");
        _manyHolders(62, "62"); // + issuer + paying agent... the issuer and investors are the ledger's accounts
    }

    function _manyHolders(uint256 n, string memory label) internal {
        Fixture memory f = _fixture(3); // phoenix (memory), notional 1,000 units
        uint256 pid = _issue(f, makeAddr(string.concat("I", label)), makeAddr(string.concat("P", label)));
        int256 units = int256(1000 / n) * SCALE;
        for (uint256 k = 0; k < n; k++) {
            _subscribe(f, pid, makeAddr(string.concat("h", label, "_", vm.toString(k))), units, uint256(units / SCALE) * 1e6);
        }
        _observe(f, pid);
        int256[] memory atStrike = f.strikes;
        vm.warp(f.obsAt[0]);
        uint256 coupon = _report(pid, f.observeSteps[0], atStrike); // coupon paid to every holder
        vm.warp(f.obsAt[1]);
        uint256 callGas = _report(pid, f.observeSteps[1], atStrike); // coupon + autocall + redemption
        assertEq(engine.processOf(pid).status, engine.COMPLETED());
        console2.log(string.concat("holders ", label, ": coupon observation gas"), coupon);
        console2.log(string.concat("holders ", label, ": coupon + call + redemption gas"), callGas);
        assertLt(callGas, 3_000_000, "stays under a 3M gas budget");
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
