// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CrossChainMessages as M} from "./CrossChainMessages.sol";
import {RemoteReceipt} from "./RemoteReceipt.sol";

/// @title HomeGateway
/// @notice Sits next to the FlowEngine on a note's home chain (Arbitrum) and connects it, over Chainlink CCIP, to
///         RemoteVaults on the chains where collateral stays locked (Robinhood Chain first; any CCIP chain is a
///         configuration change: deploy a vault there, then `setRemote` and `registerReceipt` here).
///         - LOCKED from an allow-listed vault: mint RemoteReceipts to the locker (once per lock id).
///         - `redeem`: burn receipts and send RELEASE to the vault, which pays the locked asset on its chain.
///         The engine is not changed: receipts are ordinary collateral assets to it, so pledging, coverage and
///         margin (Chainlink price x haircut, summed over every collateral asset, local or remote), release at
///         maturity and the default rule (cap-at-owed or all-to-holders) all run on the engine's tested paths.
/// @dev Trust: a LOCKED message is accepted only from the vault configured for its source chain selector, and
///      only through the CCIP router (CCIPReceiver.onlyRouter). Pause stops redemptions (outbound), never inbound
///      locks; nothing here can move a receipt or the locked asset on anyone's behalf.
contract HomeGateway is CCIPReceiver, Ownable2Step, ReentrancyGuard, Pausable {
    struct Remote {
        address vault; // the RemoteVault on that chain (0 = not allowed)
        uint32 gasLimit; // gas for the RELEASE execution on that chain
    }

    struct ReceiptInfo {
        uint64 chainSelector;
        address remoteToken;
    }

    /// @notice The engine the receipts may move into and out of.
    address public immutable engine;
    /// @notice Allow-listed vault per remote chain selector.
    mapping(uint64 chainSelector => Remote) public remotes;
    /// @notice The receipt for a locked token on a remote chain.
    mapping(uint64 chainSelector => mapping(address remoteToken => address receipt)) public receiptOf;
    /// @notice What a receipt stands for.
    mapping(address receipt => ReceiptInfo) public receiptInfo;
    /// @notice Lock ids already credited (CCIP delivers at most once; this also covers a replayed manual execution).
    mapping(bytes32 lockId => bool) public credited;
    /// @notice Redemptions sent so far (also the nonce of the next redeem id).
    uint256 public redemptions;

    event RemoteSet(uint64 indexed chainSelector, address vault, uint32 gasLimit);
    event ReceiptRegistered(uint64 indexed chainSelector, address indexed remoteToken, address receipt);
    /// @notice A remote lock arrived and its receipts were minted.
    event LockCredited(
        bytes32 indexed lockId, uint64 indexed chainSelector, address indexed account, address receipt, uint256 amount, bytes32 messageId
    );
    /// @notice A lock id arrived again and was ignored.
    event DuplicateLock(bytes32 indexed lockId, bytes32 messageId);
    /// @notice Receipts were burned and a RELEASE sent to the vault.
    event RedeemSent(
        bytes32 indexed redeemId, uint64 indexed chainSelector, address indexed from, address to, address receipt, uint256 amount, bytes32 messageId, uint256 fee
    );

    error UnknownSender(uint64 chainSelector, address sender);
    error UnknownReceipt();
    error UnknownToken(uint64 chainSelector, address remoteToken);
    error AlreadyRegistered();
    error WrongKind();
    error BadInputs();
    error FeeTooLow(uint256 fee);
    error RefundFailed();

    constructor(address router, address owner_, address engine_) CCIPReceiver(router) Ownable(owner_) {
        if (engine_ == address(0)) revert BadInputs();
        engine = engine_;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Configuration (owner)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Allow (or, with vault = 0, remove) the vault on a remote chain.
    function setRemote(uint64 chainSelector, address vault, uint32 gasLimit) external onlyOwner {
        if (chainSelector == 0 || (vault != address(0) && gasLimit < 50_000)) revert BadInputs();
        remotes[chainSelector] = Remote(vault, gasLimit);
        emit RemoteSet(chainSelector, vault, gasLimit);
    }

    /// @notice Create the receipt for `remoteToken` locked on `chainSelector` (same decimals as that token).
    function registerReceipt(uint64 chainSelector, address remoteToken, uint8 decimals_, string calldata name_, string calldata symbol_)
        external
        onlyOwner
        returns (address receipt)
    {
        if (chainSelector == 0 || remoteToken == address(0) || decimals_ > 18) revert BadInputs();
        if (receiptOf[chainSelector][remoteToken] != address(0)) revert AlreadyRegistered();
        receipt = address(new RemoteReceipt(name_, symbol_, decimals_, engine, chainSelector, remoteToken));
        receiptOf[chainSelector][remoteToken] = receipt;
        receiptInfo[receipt] = ReceiptInfo(chainSelector, remoteToken);
        emit ReceiptRegistered(chainSelector, remoteToken, receipt);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Inbound: LOCKED
    // ---------------------------------------------------------------------------------------------------------

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override nonReentrant {
        Remote memory r = remotes[message.sourceChainSelector];
        address sender = abi.decode(message.sender, (address));
        if (r.vault == address(0) || sender != r.vault) revert UnknownSender(message.sourceChainSelector, sender);
        (uint8 kind, bytes32 lockId, address account, address remoteToken, uint256 amount) = M.decode(message.data);
        if (kind != M.LOCKED) revert WrongKind();
        if (credited[lockId]) {
            emit DuplicateLock(lockId, message.messageId);
            return; // succeed without effect, so a replay is marked done rather than retried
        }
        address receipt = receiptOf[message.sourceChainSelector][remoteToken];
        // Reverting leaves the message executable: register the receipt, then execute it manually.
        if (receipt == address(0)) revert UnknownToken(message.sourceChainSelector, remoteToken);
        credited[lockId] = true;
        RemoteReceipt(receipt).mint(account, amount);
        emit LockCredited(lockId, message.sourceChainSelector, account, receipt, amount, message.messageId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Outbound: RELEASE
    // ---------------------------------------------------------------------------------------------------------

    /// @notice The CCIP fee (native) for redeeming `amount` of `receipt` to `to` on its chain.
    function quoteRedeem(address receipt, uint256 amount, address to) external view returns (uint256) {
        (uint64 chainSelector, Client.EVM2AnyMessage memory m) = _releaseMessage(receipt, bytes32(0), amount, to);
        return IRouterClient(getRouter()).getFee(chainSelector, m);
    }

    /// @notice Burn `amount` of your receipts and have the vault pay the locked asset to `to` on its chain.
    ///         `to` is usually your own address (the same EVM address on every chain). Pay the CCIP fee in
    ///         `msg.value` (see `quoteRedeem`); the excess is refunded.
    function redeem(address receipt, uint256 amount, address to) external payable nonReentrant whenNotPaused returns (bytes32 messageId) {
        if (amount == 0 || to == address(0)) revert BadInputs();
        bytes32 redeemId = keccak256(abi.encode(block.chainid, address(this), ++redemptions));
        (uint64 chainSelector, Client.EVM2AnyMessage memory m) = _releaseMessage(receipt, redeemId, amount, to);
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(chainSelector, m);
        if (msg.value < fee) revert FeeTooLow(fee);
        RemoteReceipt(receipt).burnFrom(msg.sender, amount);
        messageId = router.ccipSend{value: fee}(chainSelector, m);
        emit RedeemSent(redeemId, chainSelector, msg.sender, to, receipt, amount, messageId, fee);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _releaseMessage(address receipt, bytes32 redeemId, uint256 amount, address to)
        internal
        view
        returns (uint64 chainSelector, Client.EVM2AnyMessage memory m)
    {
        ReceiptInfo memory info = receiptInfo[receipt];
        if (info.remoteToken == address(0)) revert UnknownReceipt();
        Remote memory r = remotes[info.chainSelector];
        if (r.vault == address(0)) revert UnknownSender(info.chainSelector, address(0));
        chainSelector = info.chainSelector;
        m = M.message(r.vault, M.encode(M.RELEASE, redeemId, to, info.remoteToken, amount), r.gasLimit);
    }
}
