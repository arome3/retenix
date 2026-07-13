// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title RetenixPolicy — the onchain authority ledger (Arbitrum One 42161)
/// @notice Plans (caps, allowlists, status) and estates (heartbeat, claim state
///         machine). The contract custodies no funds, ever — it is an authority
///         ledger, not a vault (tech spec §6). All USD integers are usd6
///         micro-USD fixed-point: $15.00 == 15_000_000 (CONFLICTS #11).
contract RetenixPolicy {
    enum PlanStatus { Active, Paused, Revoked }
    enum EstateStatus { None, Enrolled, Countdown, Claimable, Claimed, Cancelled }

    struct Plan {           // one per policy card
        address owner;      // user EOA
        address agent;      // agent EOA (delegate)
        uint96  capPerExec; // usd6 micro-USD (CONFLICTS #11)
        uint96  capPerPeriod;
        uint32  periodSecs; // e.g. 604800
        uint96  spentInPeriod;
        uint32  periodStart;
        bytes32 assetListHash;   // keccak of sorted allowed asset ids
        uint8   status;          // Active | Paused | Revoked
    }
    struct Estate {
        address owner;
        bytes32 beneficiaryHash; // keccak(email-salt) until claim; privacy
        uint64  inactivitySecs;  // demo-scaled param
        uint64  lastCheckIn;
        uint64  claimReadyAt;    // 0 until deadline fires
        uint8   status;          // Enrolled | Countdown | Claimable | Claimed | Cancelled
    }

    // --- errors (names map to receipt copy in module 08) ---
    error NotActive();
    error NotPaused();
    error NotAgent();
    error NotOwner();
    error NotRelayer();
    error NotKeeper();
    error NotForwarder();
    error NotAdmin();
    error OverExecCap();
    error OverPeriodCap();
    error AssetNotAllowed();
    error BadSignature();
    error BadNonce();
    error ListHashMismatch();
    error TooManyAssets();
    error ZeroPeriod();
    error NotEnrolled();
    error AlreadyEnrolled();
    error DeadlineNotDue();
    error NotClaimable();

    // --- storage ---
    uint256 public nextPlanId;
    mapping(uint256 => Plan) public plans;
    mapping(address => uint256[]) public plansOf;          // PROPOSED: owner enumeration for revokeAll
    mapping(uint256 => mapping(bytes32 => bool)) public allowedAssets; // PROPOSED: allowlist membership (doc 07)
    mapping(address => Estate) public estates;
    mapping(address => uint256) public authNonces;         // PROPOSED: replay protection for relayed owner ops
    address public immutable agent;                        // agent EOA (KMS) — TS-4.4
    address public immutable admin;                        // PROPOSED: deployer; gates role setters only
    address public relayer;                                // PROPOSED: Retenix relayer for checkIn (CONFLICTS #13)
    address public keeper;                                 // Retenix keeper EOA — markClaimed
    address public automationForwarder;                    // PROPOSED: Chainlink forwarder allowlist for performUpkeep
    uint64  public immutable challengeWindowSecs;          // §9: claimReadyAt = now + challengeWindow (governance-set)
    address[] public enrolledOwners;                       // PROPOSED: iteration set for checkUpkeep

    // --- events (every state change emits) ---
    event PlanCreated(uint256 indexed id, address indexed owner, address agent,
        uint96 capPerExec, uint96 capPerPeriod, uint32 periodSecs, bytes32 assetListHash,
        string[] assetIds);
    event ExecutionRecorded(uint256 indexed id, uint96 usd, bytes32 assetId, uint96 spentInPeriod);
    event ExecutionRefunded(uint256 indexed id, uint96 usd);
    event PlanPaused(uint256 indexed id);
    event PlanResumed(uint256 indexed id);
    event PlanRevoked(uint256 indexed id);
    event EstateEnrolled(address indexed owner, bytes32 beneficiaryHash, uint64 inactivitySecs);
    event CheckedIn(address indexed owner, uint64 at);
    event DeadlineFired(address indexed owner, uint64 claimReadyAt);
    event ClaimCancelled(address indexed owner);
    event Claimed(address indexed owner, address heir);
    event RoleSet(bytes32 indexed role, address account);

    constructor(address agent_, address keeper_, address relayer_, uint64 challengeWindowSecs_) {
        agent = agent_;
        keeper = keeper_;
        relayer = relayer_;
        challengeWindowSecs = challengeWindowSecs_;
        admin = msg.sender;
    }

    // --- relayed auth: EIP-191 personal_sign over
    //     keccak256(abi.encode(chainid, address(this), "<op>", ...params, nonce)) ---
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        address signer = ecrecover(
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)), v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    function _useNonce(address owner, uint256 nonce) internal {
        if (nonce != authNonces[owner]) revert BadNonce();
        unchecked { authNonces[owner] = nonce + 1; }
    }

    // --- plans ---
    /// @notice Owner-signed, relayer-submitted (gasless UX). `assetIds` is the
    ///         plaintext allowlist (pre-sorted, "|"-preimage of assetListHash);
    ///         the owner's signature covers assetListHash, so a relayer cannot
    ///         substitute the list without breaking the hash check.
    function createPlan(address owner, uint96 capPerExec, uint96 capPerPeriod, uint32 periodSecs,
        bytes32 assetListHash, string[] calldata assetIds, uint256 nonce, bytes calldata ownerSig)
        external returns (uint256 id)
    {
        if (periodSecs == 0) revert ZeroPeriod();
        if (assetIds.length > 5) revert TooManyAssets();
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "createPlan",
            agent, capPerExec, capPerPeriod, periodSecs, assetListHash, nonce));
        if (_recover(digest, ownerSig) != owner) revert BadSignature();
        _useNonce(owner, nonce);
        bytes memory joined;
        for (uint256 i = 0; i < assetIds.length; i++) {
            joined = i == 0 ? bytes(assetIds[i]) : abi.encodePacked(joined, "|", assetIds[i]);
        }
        if (keccak256(joined) != assetListHash) revert ListHashMismatch();
        id = nextPlanId++;
        plans[id] = Plan(owner, agent, capPerExec, capPerPeriod, periodSecs, 0,
            uint32(block.timestamp), assetListHash, uint8(PlanStatus.Active));
        plansOf[owner].push(id);
        for (uint256 i = 0; i < assetIds.length; i++) {
            allowedAssets[id][keccak256(bytes(assetIds[i]))] = true;
        }
        emit PlanCreated(id, owner, agent, capPerExec, capPerPeriod, periodSecs, assetListHash, assetIds);
    }

    /// @notice The gate the agent service must pass BEFORE submitting the UA
    ///         transaction (TS-6.5). Reverts: NotActive, NotAgent, OverExecCap,
    ///         OverPeriodCap (after rollover), AssetNotAllowed.
    function recordExecution(uint256 id, uint96 usd, bytes32 assetId) external {
        Plan storage p = plans[id];
        // an uninitialized plan's status is 0 == Active; the owner check makes
        // nonexistent ids revert NotActive instead of panicking on periodSecs 0
        if (p.owner == address(0) || p.status != uint8(PlanStatus.Active)) revert NotActive();
        if (msg.sender != agent) revert NotAgent();
        // comparisons widened to uint256 so uint96/uint32-boundary inputs revert
        // with named errors, never Panic(0x11) — test family 1
        if (block.timestamp >= uint256(p.periodStart) + p.periodSecs) {   // period rollover
            p.periodStart = uint32(block.timestamp) - (uint32(block.timestamp) - p.periodStart) % p.periodSecs;
            p.spentInPeriod = 0;
        }
        if (usd > p.capPerExec) revert OverExecCap();
        if (uint256(p.spentInPeriod) + usd > p.capPerPeriod) revert OverPeriodCap();
        if (!allowedAssets[id][assetId]) revert AssetNotAllowed();
        p.spentInPeriod += usd;
        emit ExecutionRecorded(id, usd, assetId, p.spentInPeriod);
    }

    /// @notice §6/§7: on buy failure the worker credits the period back. Clamped
    ///         at zero — a refund may straddle a period rollover (spent already
    ///         reset), and clamping can only reduce agent headroom (safe).
    function refundExecution(uint256 id, uint96 usd) external {
        if (msg.sender != agent) revert NotAgent();
        Plan storage p = plans[id];
        if (p.owner == address(0)) revert NotActive();
        p.spentInPeriod = usd >= p.spentInPeriod ? 0 : p.spentInPeriod - usd;
        emit ExecutionRefunded(id, usd);
    }

    function revokePlan(uint256 id) external {              // onlyOwner — one tx zeroes authority
        Plan storage p = plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        _revoke(id, p);
    }

    function revokePlanFor(uint256 id, uint256 nonce, bytes calldata ownerSig) external { // PROPOSED relayed variant
        Plan storage p = plans[id];
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "revokePlan", id, nonce));
        if (p.owner == address(0) || _recover(digest, ownerSig) != p.owner) revert BadSignature();
        _useNonce(p.owner, nonce);
        _revoke(id, p);
    }

    function _revoke(uint256 id, Plan storage p) internal {
        if (p.status == uint8(PlanStatus.Revoked)) revert NotActive();
        p.status = uint8(PlanStatus.Revoked);
        emit PlanRevoked(id);
    }

    function pausePlan(uint256 id) external {               // PROPOSED: status Paused exists in spec enum; C3 has Pause
        Plan storage p = plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (p.status != uint8(PlanStatus.Active)) revert NotActive();
        p.status = uint8(PlanStatus.Paused);
        emit PlanPaused(id);
    }

    function resumePlan(uint256 id) external {              // PROPOSED
        Plan storage p = plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (p.status != uint8(PlanStatus.Paused)) revert NotPaused();
        p.status = uint8(PlanStatus.Active);
        emit PlanResumed(id);
    }

    /// @notice PROPOSED kill switch (doc 13). NOTE: tech spec §11 says "revokePlan
    ///         all active plans (single multicall)"; a single relayed revokeAll
    ///         achieves the same "one tx zeroes authority" with simpler signature
    ///         semantics — deviation recorded in doc 07.
    function revokeAll(address owner, uint256 nonce, bytes calldata ownerSig) external {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "revokeAll", nonce));
        if (_recover(digest, ownerSig) != owner) revert BadSignature();
        _useNonce(owner, nonce);
        uint256[] storage ids = plansOf[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            Plan storage p = plans[ids[i]];
            if (p.status != uint8(PlanStatus.Revoked)) {
                p.status = uint8(PlanStatus.Revoked);
                emit PlanRevoked(ids[i]);
            }
        }
    }

    // --- estates ---
    function enrollEstate(address owner, bytes32 beneficiaryHash, uint64 inactivitySecs,
        uint256 nonce, bytes calldata ownerSig) external    // PROPOSED completion (spec §13 estate.enroll)
    {
        if (inactivitySecs == 0) revert ZeroPeriod();
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "enrollEstate",
            beneficiaryHash, inactivitySecs, nonce));
        if (_recover(digest, ownerSig) != owner) revert BadSignature();
        _useNonce(owner, nonce);
        Estate storage e = estates[owner];
        if (e.status == uint8(EstateStatus.Enrolled) || e.status == uint8(EstateStatus.Countdown)) {
            revert AlreadyEnrolled();
        }
        if (e.owner == address(0)) enrolledOwners.push(owner);
        estates[owner] = Estate(owner, beneficiaryHash, inactivitySecs,
            uint64(block.timestamp), 0, uint8(EstateStatus.Enrolled));
        emit EstateEnrolled(owner, beneficiaryHash, inactivitySecs);
    }

    /// @notice onlyRelayer (CONFLICTS #13) — the server verifies the owner's
    ///         personal_sign before relaying. A rogue bump only extends the
    ///         owner's window (safe direction). Countdown → Enrolled (veto by liveness).
    function checkIn(address owner) external {
        if (msg.sender != relayer) revert NotRelayer();
        Estate storage e = estates[owner];
        uint8 s = e.status;
        if (s != uint8(EstateStatus.Enrolled) && s != uint8(EstateStatus.Countdown)) revert NotEnrolled();
        e.lastCheckIn = uint64(block.timestamp);
        if (s == uint8(EstateStatus.Countdown)) {
            e.status = uint8(EstateStatus.Enrolled);
            e.claimReadyAt = 0;
        }
        emit CheckedIn(owner, uint64(block.timestamp));
    }

    /// @notice Condition-gated, PERMISSIONLESS (CONFLICTS #12) — Chainlink
    ///         guarantees liveness; anyone may call if the condition holds.
    function fireDeadline(address owner) external {
        _fireDeadline(owner);
    }

    function _fireDeadline(address owner) internal {
        Estate storage e = estates[owner];
        if (e.status != uint8(EstateStatus.Enrolled)) revert NotEnrolled();
        if (block.timestamp <= uint256(e.lastCheckIn) + e.inactivitySecs) revert DeadlineNotDue();
        e.claimReadyAt = uint64(block.timestamp) + challengeWindowSecs;
        e.status = uint8(EstateStatus.Countdown);
        emit DeadlineFired(owner, e.claimReadyAt);
    }

    function cancelClaim() external {                       // onlyOwner; the anti-hijack moment — wins any time before markClaimed
        Estate storage e = estates[msg.sender];
        uint8 s = e.status;
        if (s != uint8(EstateStatus.Enrolled) && s != uint8(EstateStatus.Countdown)) revert NotEnrolled();
        e.status = uint8(EstateStatus.Cancelled);
        e.claimReadyAt = 0;
        emit ClaimCancelled(msg.sender);
    }

    function markClaimed(address owner, address heir) external { // onlyKeeper; requires Claimable && now >= claimReadyAt
        if (msg.sender != keeper) revert NotKeeper();
        Estate storage e = estates[owner];
        if (e.status != uint8(EstateStatus.Countdown) || e.claimReadyAt == 0
            || block.timestamp < e.claimReadyAt) revert NotClaimable();
        e.status = uint8(EstateStatus.Claimed);
        emit Claimed(owner, heir);
    }

    /// @notice Stored Countdown reads as Claimable once claimReadyAt passes.
    function estateStatus(address owner) external view returns (EstateStatus) {
        Estate storage e = estates[owner];
        if (e.status == uint8(EstateStatus.Countdown) && e.claimReadyAt != 0
            && block.timestamp >= e.claimReadyAt) return EstateStatus.Claimable;
        return EstateStatus(e.status);
    }

    // --- Chainlink Automation (custom-logic upkeep — CONFLICTS #12) ---
    function checkUpkeep(bytes calldata) external view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 n = enrolledOwners.length;
        for (uint256 i = 0; i < n; i++) {
            address owner = enrolledOwners[i];
            Estate storage e = estates[owner];
            if (e.status == uint8(EstateStatus.Enrolled)
                && block.timestamp > uint256(e.lastCheckIn) + e.inactivitySecs) {
                return (true, abi.encode(owner));
            }
        }
        return (false, "");
    }

    function performUpkeep(bytes calldata performData) external { // onlyForwarder
        if (msg.sender != automationForwarder) revert NotForwarder();
        _fireDeadline(abi.decode(performData, (address)));  // revalidates the condition
    }

    // --- role setters (admin = deployer; agent is immutable by spec) ---
    function setRelayer(address a) external { _onlyAdmin(); relayer = a; emit RoleSet("relayer", a); }
    function setKeeper(address a) external { _onlyAdmin(); keeper = a; emit RoleSet("keeper", a); }
    function setAutomationForwarder(address a) external { _onlyAdmin(); automationForwarder = a; emit RoleSet("forwarder", a); }
    function _onlyAdmin() internal view { if (msg.sender != admin) revert NotAdmin(); }
}
