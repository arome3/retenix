// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IRetenixPolicyEstate {
    function estateStatus(address owner) external view returns (uint8);
}

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @title RetenixClaim — minimal transfer-out 7702 delegate (doc 14)
/// @notice Deployed once per EVM chain. Applied as an inactive owner's 7702
///         delegate at claim time and executed IN THE OWNER'S CONTEXT:
///         address(this) == the owner EOA, storage == the owner's own storage
///         (so `heirOf` is per-owner), and token transfers move the owner's
///         balances with no allowance. Immutables are baked into this runtime
///         code and are therefore identical under every delegation.
///
///         Audited simplicity is the point: no arbitrary execution, one
///         destination (the registered heir), keeper-gated, one-shot heir
///         registration. On Arbitrum the delegate re-checks RetenixPolicy's
///         estate state (same-chain read); other chains cannot see Arbitrum
///         state — there the keeper is trust-bounded per tech spec §10's
///         safety properties (timelock + cancel window + this contract's
///         transfer-to-registered-heir-only surface).
contract RetenixClaim {
    error NotKeeper();
    error WrongContext();
    error ZeroHeir();
    error AlreadyRegistered();
    error HeirNotSet();
    error NotClaimable();
    error PolicyRequired();
    error TransferFailed();
    error NativeSweepFailed();

    event HeirRegistered(address indexed owner, address indexed heir);
    /// token == address(0) for the native sweep.
    event AssetClaimed(address indexed owner, address indexed heir,
        address indexed token, uint256 amount);

    // RetenixPolicy.EstateStatus — enums ABI-encode as uint8, order pinned by
    // doc 07: None(0) Enrolled(1) Countdown(2) Claimable(3) Claimed(4) Cancelled(5).
    uint8 internal constant STATUS_CLAIMABLE = 3;
    uint8 internal constant STATUS_CLAIMED = 4;

    uint256 internal constant ARBITRUM_ONE = 42161;

    address public immutable keeper; // Retenix keeper EOA (KMS)
    address public immutable policy; // RetenixPolicy on Arbitrum One; address(0) elsewhere

    mapping(address => address) public heirOf; // one-shot registration per owner

    constructor(address keeper_, address policy_) {
        if (keeper_ == address(0)) revert NotKeeper();
        if (block.chainid == ARBITRUM_ONE && policy_ == address(0)) revert PolicyRequired();
        keeper = keeper_;
        policy = policy_;
    }

    /// @notice One-shot heir registration. Called at the OWNER's address after
    ///         the escrowed tuple is applied (`owner == address(this)` asserted:
    ///         calling the singleton directly, or with a mismatched owner param,
    ///         is a keeper software bug and must revert loudly, not write dead
    ///         storage). Where a same-chain policy exists (Arbitrum), the estate
    ///         must be Claimable OR Claimed — markClaimed runs FIRST in the
    ///         claim sequence, and Claimed is only reachable via the keeper's
    ///         markClaimed, which itself required Claimable; both are strictly
    ///         post-deadline, post-challenge-window states.
    function registerHeir(address owner, address heir) external {
        if (msg.sender != keeper) revert NotKeeper();
        if (owner != address(this)) revert WrongContext();
        if (heir == address(0)) revert ZeroHeir();
        if (heirOf[owner] != address(0)) revert AlreadyRegistered();
        if (policy != address(0)) {
            uint8 s = IRetenixPolicyEstate(policy).estateStatus(owner);
            if (s != STATUS_CLAIMABLE && s != STATUS_CLAIMED) revert NotClaimable();
        }
        heirOf[owner] = heir;
        emit HeirRegistered(owner, heir);
    }

    /// @notice Full balances only, destination heirOf[owner] only, no amount
    ///         params, no arbitrary calls. Re-runnable: zero balances skip.
    ///         Native is swept LAST via call (never transfer/send — the heir is
    ///         a Magic-onboarded UA, i.e. may itself carry a 7702 delegation
    ///         whose receive logic needs more than 2300 gas).
    function claim(address owner, address[] calldata tokens) external {
        if (msg.sender != keeper) revert NotKeeper();
        if (owner != address(this)) revert WrongContext();
        address heir = heirOf[owner];
        if (heir == address(0)) revert HeirNotSet();
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20Minimal t = IERC20Minimal(tokens[i]);
            uint256 bal = t.balanceOf(address(this));
            if (bal == 0) continue;
            // tolerate no-return ERC20s (USDT): success + (empty or true) returndata
            (bool ok, bytes memory ret) =
                address(t).call(abi.encodeCall(IERC20Minimal.transfer, (heir, bal)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
            emit AssetClaimed(owner, heir, tokens[i], bal);
        }
        uint256 nat = address(this).balance;
        if (nat != 0) {
            (bool ok2,) = heir.call{value: nat}("");
            if (!ok2) revert NativeSweepFailed();
            emit AssetClaimed(owner, heir, address(0), nat);
        }
    }

    /// @notice While delegated, plain native transfers TO the owner execute
    ///         this code; without a payable receive they would bounce.
    receive() external payable {}
}
