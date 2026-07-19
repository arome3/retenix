// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title RetenixHedge — onchain caps for Guardian Hedge mode (doc 19, F12)
/// @notice A COMPANION to RetenixPolicy, not an extension of it (decision D-H1).
///         RetenixPolicy is already deployed and verified on Arbitrum One, has
///         no upgradeability, and RetenixClaim holds its address `immutable` —
///         redeploying it would strand every enrolled estate and silently
///         collide `plans.contract_plan_id` (which carries no chain column).
///         So the hedge caps live here, sharing nothing but the owner/agent/
///         relayed-auth model.
///
///         Custodies no funds, ever — an authority ledger, not a vault. All USD
///         integers are usd6 micro-USD fixed-point: $15.00 == 15_000_000
///         (CONFLICTS #11). Leverage is x10 fixed-point: 20 == 2.0x.
///
/// @dev    WHAT THIS CONTRACT CAN AND CANNOT PROVE (read before trusting it).
///
///         PS-F12-AC3 as originally written — "a hedge whose notional would
///         exceed the holding's value is rejected by the contract" — is NOT
///         literally achievable: the hedged holding is an SPL token on Solana,
///         this contract is on Arbitrum, and there is no cross-chain oracle in
///         scope. Pretending otherwise would be the most dangerous kind of
///         comment. What is actually enforced is a two-layer bound:
///
///         LAYER 1 (unforgeable) — `maxNotionalUsd6` is set ONCE, under the
///         owner's own signature, at plan creation, and is immutable for the
///         plan's life. A fully compromised agent key cannot raise it; raising
///         it requires a fresh owner signature over a NEW plan.
///
///         LAYER 2 (honest-agent tightening, auditable) — per open the agent
///         attests the holding's current value, and the contract enforces
///         notional <= min(maxNotionalUsd6, attestedHoldingUsd6). The
///         attestation can only ever TIGHTEN the owner's ceiling, never widen
///         it, and it must be fresh (see `attestationMaxAgeSecs`) so a stale
///         high-water mark cannot be replayed after the holding has fallen.
///         Both values are emitted, so any offchain observer can diff the
///         attestation against the real Solana balance and catch a lying agent.
///
///         The claim that survives, exactly: a compromised agent can open at
///         most a SHORT-ONLY position, at most 2.0x, at most the owner-signed
///         ceiling, one at a time, and it can always be closed. "<= holding
///         value" is an auditable honest-agent tightening, not a contract-
///         verified fact. AC3 is reworded accordingly (HANDOFF §19).
contract RetenixHedge {
    enum HedgeStatus { Active, Paused, Revoked }

    /// @dev VERBATIM from docs/19-guardian-hedge.md:27-38 — the field list and
    ///      order are the spec's, not ours. Position state (what is currently
    ///      open) lives in sibling mappings precisely so this stays verbatim.
    struct HedgePlan {
        address owner; address agent;
        bytes32 holdingId;        // registry asset id being protected
        uint96  maxNotionalUsd6;  // ≤ holding value at open, re-attested per open
        uint16  maxLeverageX10;   // 20 = 2.0x hard cap
        uint8   direction;        // SHORT_ONLY = 0; anything else reverts
        uint8   status;           // Active | Paused | Revoked
    }

    // --- errors (names map to receipt copy in the worker's hedge block) ---
    error NotActive();
    error NotPaused();
    error NotAgent();
    error NotOwner();
    error NotAdmin();
    error BadSignature();
    error BadNonce();
    error ZeroNotional();
    error ZeroLeverage();
    error ZeroHolding();
    error OverNotionalCap();
    error OverLeverageCap();
    error WrongDirection();
    error AlreadyOpen();
    error StaleAttestation();

    // --- storage ---
    uint256 public nextHedgePlanId;
    mapping(uint256 => HedgePlan) public hedgePlans;
    mapping(address => uint256[]) public hedgePlansOf;   // owner enumeration for revokeAllHedges
    /// @notice Notional of the CURRENTLY OPEN position, 0 when flat.
    /// @dev    doc 19 lists three functions, none of which bound AGGREGATE
    ///         exposure — without this an agent could call recordHedgeOpen N
    ///         times, each individually within cap, for N x maxNotional of
    ///         total short. This mapping plus AlreadyOpen() is what makes the
    ///         ceiling mean what a reader assumes it means.
    mapping(uint256 => uint96) public openNotionalUsd6;
    mapping(uint256 => bytes32) public openPairId;
    /// @dev SEPARATE nonce space from RetenixPolicy. Cross-contract replay is
    ///      already impossible (every digest binds address(this)), but a relay
    ///      helper that reads its nonce from the POLICY contract will produce
    ///      BadNonce on every hedge mutation. Read nonces from the contract you
    ///      are about to call.
    mapping(address => uint256) public authNonces;
    address public immutable agent;                      // agent EOA (KMS) — TS-4.4
    address public immutable admin;                      // deployer; reserved for future role setters
    /// @notice Max age of the per-open holding-value attestation, in seconds.
    /// @dev    Immutable + constructor-set, mirroring RetenixPolicy's
    ///         challengeWindowSecs: a governance-tuned time window, demo-scalable.
    uint64  public immutable attestationMaxAgeSecs;

    uint8  internal constant SHORT_ONLY  = 0;
    /// @dev 20 == 2.0x. The hard ceiling from doc 19 — a plan may set a LOWER
    ///      per-plan cap but never a higher one, and this is re-checked on every
    ///      open. Note the units: an off-by-ten here is a 20x hedge, not 2x.
    uint16 internal constant MAX_LEVERAGE_X10 = 20;

    // --- events (every state change emits) ---
    event HedgePlanCreated(uint256 indexed id, address indexed owner, address agent,
        bytes32 holdingId, uint96 maxNotionalUsd6, uint16 maxLeverageX10);
    /// @dev Emits BOTH the attested holding value and its timestamp so the
    ///      attestation is publicly auditable against the real Solana balance.
    event HedgeOpened(uint256 indexed id, uint96 notionalUsd6, uint16 levX10, bytes32 pairId,
        uint96 attestedHoldingUsd6, uint64 attestedAt);
    event HedgeClosed(uint256 indexed id, uint96 notionalUsd6, bytes32 pairId);
    event HedgePlanPaused(uint256 indexed id);
    event HedgePlanResumed(uint256 indexed id);
    event HedgePlanRevoked(uint256 indexed id);

    constructor(address agent_, uint64 attestationMaxAgeSecs_) {
        agent = agent_;
        attestationMaxAgeSecs = attestationMaxAgeSecs_;
        admin = msg.sender;
    }

    // --- relayed auth: EIP-191 personal_sign over
    //     keccak256(abi.encode(chainid, address(this), "<op>", ...params, nonce)) ---
    //     Copied verbatim from RetenixPolicy so the TS digest builders and the
    //     cross-impl fixture vectors stay one implementation, not two.
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
    /// @notice Owner-signed, relayer-submitted (gasless UX). THE ONLY place
    ///         `maxNotionalUsd6` is ever set — that is what makes it the
    ///         unforgeable half of the cap (see the contract-level notes).
    /// @param  direction must be SHORT_ONLY. Taken as a parameter rather than
    ///         forced to 0 so an attempted long fails LOUDLY at creation
    ///         instead of being silently rewritten into a short.
    function createHedgePlan(address owner, bytes32 holdingId, uint96 maxNotionalUsd6,
        uint16 maxLeverageX10, uint8 direction, uint256 nonce, bytes calldata ownerSig)
        external returns (uint256 id)
    {
        if (direction != SHORT_ONLY) revert WrongDirection();
        if (maxNotionalUsd6 == 0) revert ZeroNotional();
        if (maxLeverageX10 == 0) revert ZeroLeverage();
        if (maxLeverageX10 > MAX_LEVERAGE_X10) revert OverLeverageCap();
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "createHedgePlan",
            agent, holdingId, maxNotionalUsd6, maxLeverageX10, nonce));
        if (_recover(digest, ownerSig) != owner) revert BadSignature();
        _useNonce(owner, nonce);
        id = nextHedgePlanId++;
        hedgePlans[id] = HedgePlan(owner, agent, holdingId, maxNotionalUsd6,
            maxLeverageX10, SHORT_ONLY, uint8(HedgeStatus.Active));
        hedgePlansOf[owner].push(id);
        emit HedgePlanCreated(id, owner, agent, holdingId, maxNotionalUsd6, maxLeverageX10);
    }

    /// @notice The gate the worker must pass BEFORE funding a position at the
    ///         venue (doc 19 §Implementation). Reverts: NotActive, NotAgent,
    ///         AlreadyOpen, ZeroNotional, ZeroLeverage, OverLeverageCap,
    ///         ZeroHolding, StaleAttestation, OverNotionalCap.
    /// @dev    Extends doc 19's signature with the attestation pair. The doc's
    ///         own struct comment ("<= holding value at open, re-attested per
    ///         open") requires the attestation to reach the contract somehow;
    ///         its four-parameter signature provides no channel for it. Recorded
    ///         as a deliberate deviation in HANDOFF §19.
    function recordHedgeOpen(uint256 id, uint96 notionalUsd6, uint16 levX10, bytes32 pairId,
        uint96 attestedHoldingUsd6, uint64 attestedAt) external
    {
        if (msg.sender != agent) revert NotAgent();
        HedgePlan storage h = hedgePlans[id];
        // an uninitialized plan's status is 0 == Active; the owner check makes
        // nonexistent ids revert NotActive rather than opening a phantom plan
        if (h.owner == address(0) || h.status != uint8(HedgeStatus.Active)) revert NotActive();
        if (h.direction != SHORT_ONLY) revert WrongDirection();   // defence in depth
        if (openNotionalUsd6[id] != 0) revert AlreadyOpen();
        if (notionalUsd6 == 0) revert ZeroNotional();
        if (levX10 == 0) revert ZeroLeverage();
        if (levX10 > MAX_LEVERAGE_X10 || levX10 > h.maxLeverageX10) revert OverLeverageCap();
        if (attestedHoldingUsd6 == 0) revert ZeroHolding();
        // A future-dated attestation is as much a forgery signal as a stale one.
        if (attestedAt > block.timestamp) revert StaleAttestation();
        if (block.timestamp - attestedAt > attestationMaxAgeSecs) revert StaleAttestation();
        // The attestation may only TIGHTEN the owner-signed ceiling.
        uint96 cap = attestedHoldingUsd6 < h.maxNotionalUsd6 ? attestedHoldingUsd6 : h.maxNotionalUsd6;
        if (notionalUsd6 > cap) revert OverNotionalCap();
        openNotionalUsd6[id] = notionalUsd6;
        openPairId[id] = pairId;
        emit HedgeOpened(id, notionalUsd6, levX10, pairId, attestedHoldingUsd6, attestedAt);
    }

    /// @notice Close is NEVER gated by plan status, and is IDEMPOTENT.
    /// @dev    Both properties exist for the kill switch (PS-F12-AC4, doc 13's
    ///         "can never block your kill switch"). Ungated: revokeAllHedges
    ///         runs BEFORE the closes, so a status check here would strand every
    ///         open position at exactly the moment the user asked for everything
    ///         out. Idempotent: a second close is a silent no-op rather than a
    ///         revert, so the kill path can retry blindly without a staticcall
    ///         pre-check and without a revert being mistaken for a failure.
    ///         Do not "harden" either property — they ARE the guarantee.
    function recordHedgeClose(uint256 id) external {
        if (msg.sender != agent) revert NotAgent();
        if (hedgePlans[id].owner == address(0)) revert NotActive();
        uint96 n = openNotionalUsd6[id];
        if (n == 0) return;                        // already flat — no-op, never a revert
        bytes32 pair = openPairId[id];
        openNotionalUsd6[id] = 0;
        openPairId[id] = bytes32(0);
        emit HedgeClosed(id, n, pair);
    }

    function revokeHedgePlan(uint256 id) external {          // onlyOwner
        HedgePlan storage h = hedgePlans[id];
        if (msg.sender != h.owner) revert NotOwner();
        _revoke(id, h);
    }

    function revokeHedgePlanFor(uint256 id, uint256 nonce, bytes calldata ownerSig) external {
        HedgePlan storage h = hedgePlans[id];
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "revokeHedgePlan", id, nonce));
        if (h.owner == address(0) || _recover(digest, ownerSig) != h.owner) revert BadSignature();
        _useNonce(h.owner, nonce);
        _revoke(id, h);
    }

    /// @dev Revoking does NOT close. Closing is a separate, never-gated call —
    ///      that separation is exactly what makes the kill switch's ordering
    ///      (revoke-all -> close hedges -> sell legs) safe to run in that order.
    function _revoke(uint256 id, HedgePlan storage h) internal {
        if (h.status == uint8(HedgeStatus.Revoked)) revert NotActive();
        h.status = uint8(HedgeStatus.Revoked);
        emit HedgePlanRevoked(id);
    }

    function pauseHedgePlan(uint256 id) external {
        HedgePlan storage h = hedgePlans[id];
        if (msg.sender != h.owner) revert NotOwner();
        if (h.status != uint8(HedgeStatus.Active)) revert NotActive();
        h.status = uint8(HedgeStatus.Paused);
        emit HedgePlanPaused(id);
    }

    function resumeHedgePlan(uint256 id) external {
        HedgePlan storage h = hedgePlans[id];
        if (msg.sender != h.owner) revert NotOwner();
        if (h.status != uint8(HedgeStatus.Paused)) revert NotPaused();
        h.status = uint8(HedgeStatus.Active);
        emit HedgePlanResumed(id);
    }

    /// @notice Kill-switch parity with RetenixPolicy.revokeAll — one relayed tx
    ///         zeroes every hedge authority. Idempotent over already-revoked
    ///         plans, so a duplicate submission converges.
    function revokeAllHedges(address owner, uint256 nonce, bytes calldata ownerSig) external {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), "revokeAllHedges", nonce));
        if (_recover(digest, ownerSig) != owner) revert BadSignature();
        _useNonce(owner, nonce);
        uint256[] storage ids = hedgePlansOf[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            HedgePlan storage h = hedgePlans[ids[i]];
            if (h.status != uint8(HedgeStatus.Revoked)) {
                h.status = uint8(HedgeStatus.Revoked);
                emit HedgePlanRevoked(ids[i]);
            }
        }
    }

    /// @notice Owner's hedge plan ids (kill-switch enumeration; plansOf's twin).
    function hedgePlanCountOf(address owner) external view returns (uint256) {
        return hedgePlansOf[owner].length;
    }
}
