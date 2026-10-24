// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Vm, console2} from "forge-std/Test.sol";
import {ProductsBase} from "./Products.t.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";
import {RemoteReceipt} from "../src/crosschain/RemoteReceipt.sol";
import {CrossChainMessages} from "../src/crosschain/CrossChainMessages.sol";
import {MockCCIPRouter} from "./mocks/MockCCIPRouter.sol";
import {MockERC20, FreezableERC20} from "./mocks/MockERC20.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/// Stage 1 of the cross-chain lifecycle: a note runs on its home chain (Arbitrum) while its collateral stays
/// locked on other chains (Robinhood Chain, Base), coordinated by CCIP. The note fixtures that pledge collateral
/// are replayed with that collateral locked remotely: the issuer locks it in the vault, the gateway mints receipts,
/// the engine uses them exactly like local collateral (coverage, margin calls, release, the default rule), and at
/// the end every receipt is redeemed for the real asset on its own chain. Every amount must equal the reference.
contract CrossChainTest is ProductsBase {
    uint64 constant ARB = 3478487238524512106; // Arbitrum Sepolia (home)
    uint64 constant RH = 2032988798112970440; // Robinhood Chain testnet
    uint64 constant BASE = 10344971235874465080; // Base Sepolia
    uint256 constant FEE = 0.001 ether;

    MockCCIPRouter homeRouter;
    MockCCIPRouter rhRouter;
    MockCCIPRouter baseRouter;
    HomeGateway gateway;
    RemoteVault rhVault;
    RemoteVault baseVault;
    FreezableERC20 rhEth; // the ETH-like collateral token on Robinhood (18 decimals, as the fixtures' WETH)
    FreezableERC20 baseUsdg; // a stablecoin on Base (6 decimals, as the fixtures' USD collateral)
    RemoteReceipt rEth;
    RemoteReceipt rUsd;

    function setUp() public override {
        super.setUp();
        homeRouter = new MockCCIPRouter(ARB, FEE);
        rhRouter = new MockCCIPRouter(RH, FEE);
        baseRouter = new MockCCIPRouter(BASE, FEE);
        homeRouter.connect(rhRouter);
        homeRouter.connect(baseRouter);
        rhRouter.connect(homeRouter);
        baseRouter.connect(homeRouter);

        gateway = new HomeGateway(address(homeRouter), admin, address(engine));
        rhVault = new RemoteVault(address(rhRouter), admin, ARB);
        baseVault = new RemoteVault(address(baseRouter), admin, ARB);
        rhEth = new FreezableERC20("ETH.rh", 18);
        baseUsdg = new FreezableERC20("USDG.base", 6);

        vm.startPrank(admin);
        rhVault.setHomeGateway(address(gateway));
        baseVault.setHomeGateway(address(gateway));
        rhVault.setToken(address(rhEth), true);
        baseVault.setToken(address(baseUsdg), true);
        gateway.setRemote(RH, address(rhVault), 300_000);
        gateway.setRemote(BASE, address(baseVault), 300_000);
        rEth = RemoteReceipt(gateway.registerReceipt(RH, address(rhEth), 18, "ETH locked on Robinhood Chain", "ETH.rh"));
        rUsd = RemoteReceipt(gateway.registerReceipt(BASE, address(baseUsdg), 6, "USDG locked on Base", "USDG.base"));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------

    function _idx(string memory needle) internal view returns (uint256) {
        for (uint256 i = 0; i < fixtures.length; i++) {
            if (vm.indexOf(_fixture(i).name, needle) != type(uint256).max) return i;
        }
        revert("fixture not found");
    }

    /// Which remote receipt stands in for asset `a` (0 = keep the local token).
    function _receiptFor(Fixture memory f, uint256 a) internal view returns (RemoteReceipt) {
        if (f.tokenOf[a] == 2) return rEth; // ETH collateral: on Robinhood
        if (f.tokenOf[a] == 1 && a != CASH) return rUsd; // stablecoin collateral (not the cash leg): on Base
        return RemoteReceipt(address(0));
    }

    function _assetTokensRemote(Fixture memory f) internal view returns (address[] memory t) {
        t = new address[](f.tokenOf.length);
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            RemoteReceipt r = _receiptFor(f, a);
            if (address(r) != address(0)) t[a] = address(r);
            else if (f.tokenOf[a] != 0) t[a] = address(tokens[f.tokenOf[a]]);
        }
    }

    /// The issuer locks `base` of the asset behind `r` on its chain; the lock is delivered home unless `deliver` is false.
    function _lockRemote(RemoteReceipt r, address who, uint256 base, bool deliver) internal returns (uint256 msgIndex) {
        (RemoteVault vault, FreezableERC20 token, MockCCIPRouter router) =
            r == rEth ? (rhVault, rhEth, rhRouter) : (baseVault, baseUsdg, baseRouter);
        token.mint(who, base);
        vm.deal(who, who.balance + FEE);
        vm.startPrank(who);
        token.approve(address(vault), base);
        vault.lock{value: FEE}(address(token), base, who);
        vm.stopPrank();
        msgIndex = router.count() - 1;
        if (deliver) router.deliver(msgIndex);
    }

    /// Redeem `base` receipts held by `who` for the real asset on its chain; returns what arrived there.
    function _redeem(RemoteReceipt r, address who, uint256 base) internal returns (uint256 got) {
        FreezableERC20 token = r == rEth ? rhEth : baseUsdg;
        uint256 before = token.balanceOf(who);
        vm.deal(who, who.balance + FEE);
        vm.prank(who);
        gateway.redeem{value: FEE}(address(r), base, who);
        homeRouter.deliver(homeRouter.count() - 1); // RELEASE runs on the asset chain
        got = token.balanceOf(who) - before;
    }

    function _issueRemote(Fixture memory f, address issuer, address pa) internal returns (uint256 pid) {
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        vm.prank(issuer);
        pid = engine.startProcess(id, 1, _roles(issuer, pa), _assetTokensRemote(f), f.startStep, _none(), "Note", "NOTE");
        vm.startPrank(issuer);
        for (uint256 t = 1; t < 5; t++) tokens[t].approve(address(engine), type(uint256).max);
        rEth.approve(address(engine), type(uint256).max);
        rUsd.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        // Pledges of remote collateral: locked on their chain first (the receipts arrive over CCIP).
        for (uint256 k = 0; k < f.pledges.length; k++) {
            Pledge memory p = f.pledges[k];
            RemoteReceipt r = _receiptForToken(f, p.token);
            if (address(r) != address(0)) _lockRemote(r, issuer, p.base, true);
            else tokens[p.token].mint(issuer, p.base);
        }
        vm.startPrank(issuer);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
    }

    /// The fixtures name a pledge by token id: 2 = ETH (remote, Robinhood); 1 with a stablecoin collateral asset in
    /// the note = USD collateral (remote, Base) only when the cash leg is minted separately (see _cashPledges).
    function _receiptForToken(Fixture memory f, uint8 token) internal view returns (RemoteReceipt) {
        if (token == 2) return rEth;
        if (token == 1 && _hasUsdCollateral(f)) return rUsd;
        return RemoteReceipt(address(0));
    }

    function _hasUsdCollateral(Fixture memory f) internal pure returns (bool) {
        for (uint256 a = CASH + 1; a < f.tokenOf.length; a++) if (f.tokenOf[a] == 1) return true;
        return false;
    }

    /// Replay the timeline; top-ups of remote collateral are locked remotely and arrive late: the first attempt to
    /// pledge them (before the CCIP message lands) fails, the second (after) succeeds, inside the grace period.
    function _playRemote(Fixture memory f, uint256 pid, address issuer) internal {
        for (uint256 i = 0; i < f.actions.length; i++) {
            Action memory a = f.actions[i];
            if (a.at > block.timestamp) vm.warp(a.at);
            if (a.kind == 1) {
                _report(pid, a.step, a.values);
            } else if (a.kind == 2) {
                _report(pid, NO, new int256[](0));
            } else if (a.kind == 3) {
                RemoteReceipt r = a.token == 2 ? rEth : RemoteReceipt(address(0));
                if (address(r) != address(0)) {
                    uint256 m = _lockRemote(r, issuer, a.base, false);
                    vm.prank(issuer);
                    vm.expectRevert(); // the receipts have not arrived yet
                    engine.executeStep(pid, a.step, NO, a.inputs);
                    rhRouter.deliver(m); // CCIP delivers (15-20 minutes on testnet)
                } else {
                    tokens[a.token].mint(issuer, a.base);
                }
                vm.prank(issuer);
                engine.executeStep(pid, a.step, NO, a.inputs);
            } else {
                revert("cross-chain fixtures have no secondary transfer");
            }
        }
    }

    function _decimalsOf(Fixture memory f, uint256 a) internal view returns (uint256) {
        RemoteReceipt r = _receiptFor(f, a);
        if (address(r) != address(0)) return r.decimals();
        return decimals[f.tokenOf[a]];
    }

    /// Withdraw every balance as its ERC-20, and redeem receipts for the real asset on its chain.
    function _cashOut(Fixture memory f, uint256 pid, address who, int256[] memory expected, string memory label) internal {
        for (uint8 a = CASH; a < f.tokenOf.length; a++) {
            int256 got = engine.balanceOf(pid, who, a);
            assertApproxEqAbs(got, expected[a], uint256(TOLERANCE), string.concat(f.name, ": ", label, " asset ", vm.toString(a)));
            uint256 base = uint256(got * int256(10 ** _decimalsOf(f, a)) / SCALE);
            if (base == 0) continue;
            vm.prank(who);
            engine.withdraw(pid, a, base);
            RemoteReceipt r = _receiptFor(f, a);
            if (address(r) != address(0)) {
                assertEq(r.balanceOf(who), base, "receipts withdrawn from the engine");
                assertEq(_redeem(r, who, base), base, string.concat(f.name, ": ", label, " paid in the real asset on its chain"));
                assertEq(r.balanceOf(who), 0, "receipts burned");
            }
        }
    }

    function _runRemote(uint256 idx) internal returns (uint256 pid, address issuer) {
        Fixture memory f = _fixture(idx);
        issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        address pa = makeAddr(string.concat("pa", vm.toString(idx)));
        pid = _issueRemote(f, issuer, pa);
        address[] memory holders = _holders(f, idx);
        for (uint256 k = 0; k < f.investorUnits.length; k++) _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);
        assertEq(f.transferUnits, 0, "cross-chain fixtures have no secondary transfer");
        _playRemote(f, pid, issuer);
        assertEq(engine.processOf(pid).status, engine.COMPLETED(), string.concat(f.name, ": completed"));
        for (uint256 k = 0; k < holders.length; k++) _cashOut(f, pid, holders[k], f.expected[k], string.concat("holder ", vm.toString(k)));
        // The issuer: proceeds (cash) and collateral released to it, back as the real asset on its chain.
        int256[] memory issuerEnd = new int256[](f.tokenOf.length);
        issuerEnd[CASH] = engine.balanceOf(pid, issuer, CASH);
        for (uint256 a = CASH + 1; a < f.tokenOf.length; a++) issuerEnd[a] = f.issuerCollateral[a];
        _cashOut(f, pid, issuer, issuerEnd, "issuer");
        // Every receipt redeemed: what the vaults still lock equals what is outstanding at home (dust only).
        assertEq(rhVault.locked(address(rhEth)), rEth.totalSupply(), "Robinhood vault: locked = receipts outstanding");
        assertEq(baseVault.locked(address(baseUsdg)), rUsd.totalSupply(), "Base vault: locked = receipts outstanding");
    }

    // ---------------------------------------------------------------------------------------------------------
    // The lifecycle with remote collateral
    // ---------------------------------------------------------------------------------------------------------

    /// ETH collateral locked on Robinhood: a margin call (ETH falls 40%) cured by a top-up that is itself locked
    /// remotely and arrives late; paid in full; the collateral is released and redeemed on Robinhood.
    function test_remoteCollateral_marginCallCured_paidInFull_released() public {
        uint256 i = _idx("margin call cured");
        Fixture memory f = _fixture(i);
        assertFalse(f.defaulted);
        _runRemote(i);
        assertEq(rEth.totalSupply(), 0, "all ETH receipts redeemed");
        assertEq(rhVault.locked(address(rhEth)), 0, "nothing left locked on Robinhood");
    }

    /// Not cured: default at the end of grace; the holders receive the ETH collateral (as receipts, through the
    /// engine's default rule) and redeem it on Robinhood for real ETH, pro rata.
    function test_remoteCollateral_marginCallNotCured_defaultPaysHoldersOnRobinhood() public {
        uint256 i = _idx("margin call not cured");
        assertTrue(_fixture(i).defaulted);
        _runRemote(i);
        assertEq(rhVault.locked(address(rhEth)), rEth.totalSupply(), "locked = outstanding");
    }

    /// Collateral on TWO remote chains: stablecoin on Base and ETH on Robinhood. Coverage sums both; a missed
    /// coupon defaults; cap-at-owed pays holders the coupon plus par (stablecoin first, then ETH) and releases the
    /// rest of the ETH to the issuer, each redeemed on its own chain.
    function test_remoteCollateral_twoChains_cappedDefault() public {
        uint256 i = _idx("misses coupon 2 -> default (capped)");
        Fixture memory f = _fixture(i);
        assertTrue(f.defaulted);
        assertTrue(_hasUsdCollateral(f), "the fixture has stablecoin collateral");
        _runRemote(i);
    }

    function test_remoteCollateral_twoChains_allToHolders() public {
        _runRemote(_idx("misses coupon 2 -> default (all to holders)"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Messages
    // ---------------------------------------------------------------------------------------------------------

    function test_duplicateLockAndReleaseApplyOnce() public {
        address alice = makeAddr("alice");
        uint256 m = _lockRemote(rEth, alice, 5e9, true);
        rhRouter.deliver(m); // CCIP retry / a manual re-execution of the same message
        assertEq(rEth.balanceOf(alice), 5e9, "receipts minted once");

        // Receipts reach alice only through the engine in real use; here the gateway path is what matters.
        vm.deal(alice, FEE);
        vm.prank(alice);
        gateway.redeem{value: FEE}(address(rEth), 2e9, alice);
        uint256 r = homeRouter.count() - 1;
        homeRouter.deliver(r);
        homeRouter.deliver(r); // replay
        assertEq(rhEth.balanceOf(alice), 2e9, "released once");
        assertEq(rhVault.locked(address(rhEth)), 3e9);
        assertEq(rEth.totalSupply(), 3e9);
    }

    function test_forgedOrUnknownSendersAreRejected() public {
        bytes memory lock = CrossChainMessages.encode(CrossChainMessages.LOCKED, bytes32("x"), address(this), address(rhEth), 1e9);
        // A contract on Robinhood that is not the vault.
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.UnknownSender.selector, RH, address(0xBAD)));
        homeRouter.execute(RH, address(0xBAD), address(gateway), lock, bytes32("m1"));
        // The vault's address on a chain that is not configured.
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.UnknownSender.selector, uint64(1), address(rhVault)));
        homeRouter.execute(1, address(rhVault), address(gateway), lock, bytes32("m2"));
        // Anyone but the router.
        _callReceiveDirectly(address(gateway), RH, address(rhVault), lock);

        bytes memory rel = CrossChainMessages.encode(CrossChainMessages.RELEASE, bytes32("y"), address(this), address(rhEth), 1);
        // RELEASE from the home chain but not from the gateway, and from the gateway's address on another chain.
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.UnknownSender.selector, ARB, address(0xBAD)));
        rhRouter.execute(ARB, address(0xBAD), address(rhVault), rel, bytes32("m3"));
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.UnknownSender.selector, BASE, address(gateway)));
        rhRouter.execute(BASE, address(gateway), address(rhVault), rel, bytes32("m4"));
        // A LOCKED sent to the vault, or a RELEASE sent home, is the wrong kind.
        vm.expectRevert(RemoteVault.WrongKind.selector);
        rhRouter.execute(ARB, address(gateway), address(rhVault), lock, bytes32("m5"));
    }

    function _callReceiveDirectly(address receiver, uint64 source, address sender, bytes memory data) internal {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: bytes32("direct"),
            sourceChainSelector: source,
            sender: abi.encode(sender),
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, address(this)));
        CCIPReceiver(receiver).ccipReceive(m);
    }

    function test_releaseCannotExceedWhatIsLocked() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 1e9, true);
        bytes memory rel = CrossChainMessages.encode(CrossChainMessages.RELEASE, bytes32("big"), alice, address(rhEth), 2e9);
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.OverRelease.selector, address(rhEth), 2e9, 1e9));
        rhRouter.execute(ARB, address(gateway), address(rhVault), rel, bytes32("m"));
    }

    /// Out of order: two locks delivered in reverse; both credited, each once.
    function test_locksDeliveredOutOfOrder() public {
        address alice = makeAddr("alice");
        uint256 m1 = _lockRemote(rEth, alice, 1e9, false);
        uint256 m2 = _lockRemote(rEth, alice, 2e9, false);
        rhRouter.deliver(m2);
        assertEq(rEth.balanceOf(alice), 2e9);
        rhRouter.deliver(m1);
        assertEq(rEth.balanceOf(alice), 3e9);
        assertEq(rhVault.locked(address(rhEth)), 3e9);
    }

    /// A lock of a token the home side does not know yet fails there and stays executable: register the receipt,
    /// then execute the same message manually.
    function test_lockOfUnregisteredTokenIsRetryable() public {
        FreezableERC20 tsla = new FreezableERC20("TSLA", 18);
        vm.prank(admin);
        rhVault.setToken(address(tsla), true);
        address alice = makeAddr("alice");
        tsla.mint(alice, 3e18);
        vm.deal(alice, FEE);
        vm.startPrank(alice);
        tsla.approve(address(rhVault), 3e18);
        rhVault.lock{value: FEE}(address(tsla), 3e18, alice);
        vm.stopPrank();
        uint256 m = rhRouter.count() - 1;
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.UnknownToken.selector, RH, address(tsla)));
        rhRouter.deliver(m);
        vm.prank(admin);
        address rTsla = gateway.registerReceipt(RH, address(tsla), 18, "TSLA locked on Robinhood Chain", "TSLA.rh");
        rhRouter.deliver(m); // manual execution after the fix
        assertEq(RemoteReceipt(rTsla).balanceOf(alice), 3e18);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Receipts and vault safety
    // ---------------------------------------------------------------------------------------------------------

    function test_receiptsMoveOnlyIntoOrOutOfTheEngine() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 1e9, true);
        vm.prank(alice);
        vm.expectRevert(RemoteReceipt.ReceiptNotTransferable.selector);
        rEth.transfer(makeAddr("bob"), 1);
        vm.expectRevert(RemoteReceipt.OnlyGateway.selector);
        rEth.mint(alice, 1);
        vm.expectRevert(RemoteReceipt.OnlyGateway.selector);
        rEth.burnFrom(alice, 1);
    }

    /// The token's issuer freezes a holder (Paxos USDG and stock tokens can): the RELEASE still completes, the
    /// amount waits as unclaimed, and the holder claims it once unfrozen. No CCIP message is ever stuck.
    function test_frozenRecipientClaimsLater() public {
        address alice = makeAddr("alice");
        _lockRemote(rUsd, alice, 100e6, true);
        baseUsdg.freeze(alice, true);
        vm.deal(alice, FEE);
        vm.prank(alice);
        gateway.redeem{value: FEE}(address(rUsd), 40e6, alice);
        homeRouter.deliver(homeRouter.count() - 1);
        assertEq(baseVault.unclaimed(alice, address(baseUsdg)), 40e6);
        assertEq(baseVault.locked(address(baseUsdg)), 60e6);
        assertEq(baseVault.surplus(address(baseUsdg)), 0, "owed = locked + unclaimed");
        vm.prank(alice);
        vm.expectRevert(); // still frozen
        baseVault.claim(address(baseUsdg));
        baseUsdg.freeze(alice, false);
        vm.prank(alice);
        baseVault.claim(address(baseUsdg));
        assertEq(baseUsdg.balanceOf(alice), 40e6);
    }

    /// The token's issuer takes tokens out of the vault: the vault's surplus goes negative, which the CRE keeper
    /// reports as a shortfall against the receipts outstanding (scripts and keeper: collateralShortfalls).
    function test_vaultShortfallIsVisible() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 5e9, true);
        assertEq(rhVault.surplus(address(rhEth)), 0);
        rhEth.seize(address(rhVault), 2e9);
        assertEq(rhVault.surplus(address(rhEth)), -2e9, "shortfall visible on the asset chain");
        assertEq(rEth.totalSupply(), 5e9, "receipts outstanding at home");
    }

    /// Destination gas of each message (what the CCIP gas limits must cover): LOCKED at home, RELEASE on the vault.
    function test_messageExecutionGas() public {
        address alice = makeAddr("alice");
        uint256 m = _lockRemote(rEth, alice, 1e9, false);
        uint256 g = gasleft();
        rhRouter.deliver(m);
        uint256 lockedGas = g - gasleft();
        vm.deal(alice, FEE);
        vm.prank(alice);
        gateway.redeem{value: FEE}(address(rEth), 1e9, alice);
        uint256 r = homeRouter.count() - 1;
        g = gasleft();
        homeRouter.deliver(r);
        uint256 releaseGas = g - gasleft();
        console2.log("LOCKED execution gas (incl. mock delivery)", lockedGas);
        console2.log("RELEASE execution gas (incl. mock delivery)", releaseGas);
        assertLt(lockedGas, 200_000, "within the LOCKED gas limit");
        assertLt(releaseGas, 300_000, "within the RELEASE gas limit");
    }

    function test_feesAreChargedAndExcessRefunded() public {
        address alice = makeAddr("alice");
        rhEth.mint(alice, 1e9);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        rhEth.approve(address(rhVault), 1e9);
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.FeeTooLow.selector, FEE));
        rhVault.lock{value: FEE - 1}(address(rhEth), 1e9, alice);
        rhVault.lock{value: 1 ether}(address(rhEth), 1e9, alice);
        vm.stopPrank();
        assertEq(alice.balance, 1 ether - FEE, "excess refunded");
    }

    function test_onlyOwnerConfigures() public {
        vm.expectRevert();
        gateway.setRemote(RH, address(1), 300_000);
        vm.expectRevert();
        gateway.registerReceipt(RH, address(2), 18, "x", "x");
        vm.expectRevert();
        rhVault.setHomeGateway(address(3));
        vm.expectRevert();
        rhVault.setToken(address(4), true);
    }

    function test_pausedVaultStillReleases() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 2e9, true);
        vm.prank(admin);
        rhVault.pause();
        assertEq(_redeem(rEth, alice, 2e9), 2e9, "releases pay while new locks are paused");
    }
}
