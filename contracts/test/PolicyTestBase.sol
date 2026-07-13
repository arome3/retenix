// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RetenixPolicy} from "../src/RetenixPolicy.sol";

/// Shared deployment + relayed-auth helpers for the six doc-07 test families.
/// The digest builders mirror the PROPOSED format:
///   keccak256(abi.encode(chainid, address(policy), "<op>", ...params, nonce))
abstract contract PolicyTestBase is Test {
    RetenixPolicy internal policy;

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant STRANGER_PK = 0xB0B;
    address internal owner;
    address internal stranger;
    address internal agent;
    address internal relayer;
    address internal keeper;
    address internal forwarder;
    uint64 internal constant CHALLENGE_WINDOW = 60;

    bytes32 internal constant SPYX = keccak256("spyx");
    bytes32 internal constant TSLAX = keccak256("tslax");
    bytes32 internal constant SOL = keccak256("sol");
    bytes32 internal constant MEMECOIN = keccak256("memecoin");

    function setUp() public virtual {
        owner = vm.addr(OWNER_PK);
        stranger = vm.addr(STRANGER_PK);
        agent = makeAddr("agent");
        relayer = makeAddr("relayer");
        keeper = makeAddr("keeper");
        forwarder = makeAddr("forwarder");
        policy = new RetenixPolicy(agent, keeper, relayer, CHALLENGE_WINDOW);
        policy.setAutomationForwarder(forwarder);
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
    function createPlanDigest(
        address agent_,
        uint96 capPerExec,
        uint96 capPerPeriod,
        uint32 periodSecs,
        bytes32 listHash,
        uint256 nonce
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(policy), "createPlan",
            agent_, capPerExec, capPerPeriod, periodSecs, listHash, nonce));
    }

    function revokePlanDigest(uint256 id, uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(policy), "revokePlan", id, nonce));
    }

    function revokeAllDigest(uint256 nonce) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(policy), "revokeAll", nonce));
    }

    function enrollEstateDigest(bytes32 beneficiaryHash, uint64 inactivitySecs, uint256 nonce)
        internal view returns (bytes32)
    {
        return keccak256(abi.encode(
            block.chainid, address(policy), "enrollEstate", beneficiaryHash, inactivitySecs, nonce));
    }

    // --- allowlist preimage (sorted ids joined with "|") ---
    function joinIds(string[] memory ids) internal pure returns (bytes memory joined) {
        for (uint256 i = 0; i < ids.length; i++) {
            joined = i == 0 ? bytes(ids[i]) : abi.encodePacked(joined, "|", ids[i]);
        }
    }

    function demoIds() internal pure returns (string[] memory ids) {
        ids = new string[](3);
        ids[0] = "sol";
        ids[1] = "spyx";
        ids[2] = "tslax";
    }

    // --- flows ---
    function createDemoPlan(uint96 capPerExec, uint96 capPerPeriod, uint32 periodSecs)
        internal returns (uint256 id)
    {
        string[] memory ids = demoIds();
        bytes32 listHash = keccak256(joinIds(ids));
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createPlanDigest(agent, capPerExec, capPerPeriod, periodSecs, listHash, nonce));
        id = policy.createPlan(owner, capPerExec, capPerPeriod, periodSecs, listHash, ids, nonce, sig);
    }

    function enrollDemoEstate(uint64 inactivitySecs) internal returns (bytes32 beneficiaryHash) {
        beneficiaryHash = keccak256("heir@example.com|salt");
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, enrollEstateDigest(beneficiaryHash, inactivitySecs, nonce));
        policy.enrollEstate(owner, beneficiaryHash, inactivitySecs, nonce, sig);
    }

    // --- plan state readers (the public getter returns the full tuple) ---
    function planSpent(uint256 id) internal view returns (uint96 spent) {
        (,,,,, spent,,,) = policy.plans(id);
    }

    function planPeriodStart(uint256 id) internal view returns (uint32 start) {
        (,,,,,, start,,) = policy.plans(id);
    }

    function planStatus(uint256 id) internal view returns (uint8 status) {
        (,,,,,,,, status) = policy.plans(id);
    }
}
