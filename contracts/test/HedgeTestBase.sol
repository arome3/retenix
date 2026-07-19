// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RetenixHedge} from "../src/RetenixHedge.sol";

/// Shared deployment + relayed-auth helpers for the doc-19 hedge test families.
/// Mirrors PolicyTestBase deliberately — same OWNER_PK, same digest format
///   keccak256(abi.encode(chainid, address(hedge), "<op>", ...params, nonce))
/// so the TS digest builders stay ONE implementation across both contracts.
abstract contract HedgeTestBase is Test {
    RetenixHedge internal hedge;

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant STRANGER_PK = 0xB0B;
    address internal owner;
    address internal stranger;
    address internal agent;

    /// 15 minutes — the attestation freshness window (doc 19 PROPOSED).
    uint64 internal constant ATTESTATION_MAX_AGE = 900;

    bytes32 internal constant TSLAX = keccak256("tslax");
    bytes32 internal constant SPYX = keccak256("spyx");
    bytes32 internal constant TSLA_PAIR = keccak256("TSLA/USD");
    bytes32 internal constant BTC_PAIR = keccak256("BTC/USD");

    uint8 internal constant SHORT_ONLY = 0;
    uint16 internal constant MAX_LEV_X10 = 20; // 2.0x

    function setUp() public virtual {
        owner = vm.addr(OWNER_PK);
        stranger = vm.addr(STRANGER_PK);
        agent = makeAddr("agent");
        hedge = new RetenixHedge(agent, ATTESTATION_MAX_AGE);
        // Start well past the epoch so `block.timestamp - attestedAt` can be
        // exercised without underflowing into a nonsense age.
        vm.warp(1_760_000_000);
    }

    // --- usd6 (CONFLICTS #11): $X → micro-USD ---
    function usd6(uint256 dollars) internal pure returns (uint96) {
        return uint96(dollars * 1_000_000);
    }

    // --- EIP-191 signing over the 32-byte digest ---
    function prefixed(bytes32 digest) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory sig) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, prefixed(digest));
        sig = abi.encodePacked(r, s, v);
    }

    // --- digest builders (mirror the in-contract encodings) ---
    function createHedgePlanDigest(
        address agent_,
        bytes32 holdingId,
        uint96 maxNotionalUsd6,
        uint16 maxLeverageX10,
        uint256 nonce
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(hedge), "createHedgePlan",
            agent_, holdingId, maxNotionalUsd6, maxLeverageX10, nonce));
    }

    function revokeHedgePlanDigest(uint256 id, uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(hedge), "revokeHedgePlan", id, nonce));
    }

    function revokeAllHedgesDigest(uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(hedge), "revokeAllHedges", nonce));
    }

    // --- flows ---
    function createDemoHedgePlan(uint96 maxNotionalUsd6, uint16 maxLeverageX10)
        internal returns (uint256 id)
    {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig = sign(
            OWNER_PK, createHedgePlanDigest(agent, TSLAX, maxNotionalUsd6, maxLeverageX10, nonce));
        id = hedge.createHedgePlan(
            owner, TSLAX, maxNotionalUsd6, maxLeverageX10, SHORT_ONLY, nonce, sig);
    }

    /// Open with a fresh (now-stamped) attestation — the common-case helper.
    function openFresh(uint256 id, uint96 notionalUsd6, uint16 levX10, uint96 attestedHoldingUsd6)
        internal
    {
        vm.prank(agent);
        hedge.recordHedgeOpen(
            id, notionalUsd6, levX10, TSLA_PAIR, attestedHoldingUsd6, uint64(block.timestamp));
    }

    function revokeAsOwner(uint256 id) internal {
        vm.prank(owner);
        hedge.revokeHedgePlan(id);
    }

    function pauseAsOwner(uint256 id) internal {
        vm.prank(owner);
        hedge.pauseHedgePlan(id);
    }

    // --- plan state readers (the public getter returns the full 7-tuple) ---
    function planOwner(uint256 id) internal view returns (address o) {
        (o,,,,,,) = hedge.hedgePlans(id);
    }

    function planMaxNotional(uint256 id) internal view returns (uint96 n) {
        (,,, n,,,) = hedge.hedgePlans(id);
    }

    function planMaxLeverage(uint256 id) internal view returns (uint16 l) {
        (,,,, l,,) = hedge.hedgePlans(id);
    }

    function planDirection(uint256 id) internal view returns (uint8 d) {
        (,,,,, d,) = hedge.hedgePlans(id);
    }

    function planStatus(uint256 id) internal view returns (uint8 s) {
        (,,,,,, s) = hedge.hedgePlans(id);
    }
}
