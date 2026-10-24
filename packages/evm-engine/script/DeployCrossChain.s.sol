// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";

/// Cross-chain collateral, stage 1 (docs/CROSS-CHAIN.md). Three runs, in order:
///
///  1. Home gateway, next to the engine (Arbitrum Sepolia):
///     ROLE=gateway CHAIN=arbitrum-sepolia ENGINE=0x.. OWNER=0x.. forge script script/DeployCrossChain.s.sol --rpc-url $ARB --private-key $KEY --broadcast
///  2. Vault on the asset chain (Robinhood Chain testnet), pointed at the gateway, with its lockable tokens:
///     ROLE=vault CHAIN=robinhood-testnet HOME=arbitrum-sepolia GATEWAY=0x.. OWNER=0x.. TOKENS=0xUSDG,0xTSLA,0xAMZN,0xNFLX \
///       forge script ... --rpc-url $RH --private-key $KEY --broadcast
///  3. Wire the gateway to the vault and create one receipt per token (on the home chain):
///     ROLE=wire CHAIN=arbitrum-sepolia GATEWAY=0x.. REMOTE=robinhood-testnet VAULT=0x.. TOKENS=0x..,0x.. \
///       DECIMALS=6,18,18,18 SYMBOLS=USDG.rh,TSLA.rh,AMZN.rh,NFLX.rh forge script ... --rpc-url $ARB --private-key $KEY --broadcast
///
/// Adding another asset chain later is runs 2 and 3 again with its CHAIN/REMOTE. The OWNER must be the broadcasting
/// key for runs 2 and 3 (they configure), or a multisig that executes the same calls.
/// Routers and selectors: Chainlink's CCIP directory (docs.chain.link/ccip/directory/testnet), checked 2026-10-24,
/// and the same values in Chainlink Local's Register.
contract DeployCrossChain is Script {
    struct Net {
        uint64 selector;
        address router;
    }

    function _net(string memory name) internal pure returns (Net memory) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("arbitrum-sepolia")) return Net(3478487238524512106, 0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165);
        if (h == keccak256("robinhood-testnet")) return Net(2032988798112970440, 0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C);
        revert(string.concat("unknown chain: ", name));
    }

    function run() external {
        string memory role = vm.envString("ROLE");
        bytes32 r = keccak256(bytes(role));
        Net memory here = _net(vm.envString("CHAIN"));
        vm.startBroadcast();
        if (r == keccak256("gateway")) {
            HomeGateway g = new HomeGateway(here.router, vm.envAddress("OWNER"), vm.envAddress("ENGINE"));
            console2.log("HomeGateway", address(g));
        } else if (r == keccak256("vault")) {
            Net memory home = _net(vm.envString("HOME"));
            RemoteVault v = new RemoteVault(here.router, vm.envAddress("OWNER"), home.selector);
            v.setHomeGateway(vm.envAddress("GATEWAY"));
            address[] memory tokens = vm.envAddress("TOKENS", ",");
            for (uint256 i = 0; i < tokens.length; i++) v.setToken(tokens[i], true);
            console2.log("RemoteVault", address(v));
        } else if (r == keccak256("wire")) {
            Net memory remote = _net(vm.envString("REMOTE"));
            HomeGateway g = HomeGateway(payable(vm.envAddress("GATEWAY")));
            g.setRemote(remote.selector, vm.envAddress("VAULT"), 300_000);
            address[] memory tokens = vm.envAddress("TOKENS", ",");
            uint256[] memory decimals = vm.envUint("DECIMALS", ",");
            string[] memory symbols = vm.envString("SYMBOLS", ",");
            require(tokens.length == decimals.length && tokens.length == symbols.length, "TOKENS/DECIMALS/SYMBOLS");
            for (uint256 i = 0; i < tokens.length; i++) {
                address receipt = g.registerReceipt(
                    remote.selector, tokens[i], uint8(decimals[i]), string.concat(symbols[i], " (locked on ", vm.envString("REMOTE"), ")"), symbols[i]
                );
                console2.log(symbols[i], receipt);
            }
        } else {
            revert("ROLE: gateway | vault | wire");
        }
        vm.stopBroadcast();
    }
}
