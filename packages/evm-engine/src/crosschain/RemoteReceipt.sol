// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title RemoteReceipt
/// @notice On a note's home chain, a claim on collateral that stays locked in a RemoteVault on another chain
///         (e.g. TSLA on Robinhood Chain). One receipt contract per (remote chain, remote token).
///         The FlowEngine treats it as any other collateral ERC-20: pledged into escrow, valued with the
///         underlying's Chainlink price and haircut, released to the issuer or paid out to holders on a default,
///         all by the engine's own (tested) rules. Holders and the issuer turn receipts back into the real asset
///         on its chain with HomeGateway.redeem.
/// @dev Not a bridge: receipts are minted only by the gateway for a CCIP-verified lock, burned only by the
///      gateway on redemption, and can move only into or out of the engine (pledge in, release or payout out).
///      Between people they do not move, so no market forms in a wrapped copy of the asset.
contract RemoteReceipt is ERC20 {
    /// @notice The HomeGateway: the only minter and burner.
    address public immutable gateway;
    /// @notice The FlowEngine: the only counterparty a transfer may have.
    address public immutable engine;
    /// @notice The CCIP chain selector of the chain where the collateral is locked.
    uint64 public immutable remoteChainSelector;
    /// @notice The locked token on that chain.
    address public immutable remoteToken;
    uint8 private immutable _decimals;

    error OnlyGateway();
    /// @notice Receipts move only into or out of the engine.
    error ReceiptNotTransferable();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address engine_,
        uint64 remoteChainSelector_,
        address remoteToken_
    ) ERC20(name_, symbol_) {
        gateway = msg.sender;
        engine = engine_;
        remoteChainSelector = remoteChainSelector_;
        remoteToken = remoteToken_;
        _decimals = decimals_;
    }

    modifier onlyGateway() {
        if (msg.sender != gateway) revert OnlyGateway();
        _;
    }

    /// @notice Same decimals as the locked token, so one receipt base unit is one locked base unit.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint receipts for a lock the gateway verified over CCIP.
    function mint(address to, uint256 amount) external onlyGateway {
        _mint(to, amount);
    }

    /// @notice Burn receipts being redeemed for the locked asset (the gateway calls this for the holder).
    function burnFrom(address from, uint256 amount) external onlyGateway {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mint (from 0) and burn (to 0) pass; any transfer must have the engine on one side.
        if (from != address(0) && to != address(0) && from != engine && to != engine) revert ReceiptNotTransferable();
        super._update(from, to, value);
    }
}
