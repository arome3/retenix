// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RetenixPolicy} from "../src/RetenixPolicy.sol";
import {PolicyTestBase} from "./PolicyTestBase.sol";

/// Family 5 — auth: replayed ownerSig rejected (nonce), wrong-signer rejected,
/// onlyAgent/onlyKeeper/onlyRelayer/onlyForwarder/onlyAdmin fences; and the
/// deliberate NON-fence: fireDeadline is permissionless.
contract AuthTest is PolicyTestBase {
    uint96 internal constant CAP = 50_000_000;

    // --- relayed-op signatures & nonces ---
    function test_createPlanReplayRejected() public {
        string[] memory ids = demoIds();
        bytes32 listHash = keccak256(joinIds(ids));
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, createPlanDigest(agent, CAP, CAP, 1000, listHash, nonce));
        policy.createPlan(owner, CAP, CAP, 1000, listHash, ids, nonce, sig);
        // exact same payload again — the nonce has been consumed
        vm.expectRevert(RetenixPolicy.BadNonce.selector);
        policy.createPlan(owner, CAP, CAP, 1000, listHash, ids, nonce, sig);
    }

    function test_createPlanWrongSignerRejected() public {
        string[] memory ids = demoIds();
        bytes32 listHash = keccak256(joinIds(ids));
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(STRANGER_PK, createPlanDigest(agent, CAP, CAP, 1000, listHash, nonce));
        vm.expectRevert(RetenixPolicy.BadSignature.selector);
        policy.createPlan(owner, CAP, CAP, 1000, listHash, ids, nonce, sig);
    }

    /// A relayer cannot alter what the owner signed — any param change breaks
    /// the recovered address.
    function test_createPlanTamperedParamsRejected() public {
        string[] memory ids = demoIds();
        bytes32 listHash = keccak256(joinIds(ids));
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, createPlanDigest(agent, CAP, CAP, 1000, listHash, nonce));
        vm.expectRevert(RetenixPolicy.BadSignature.selector);
        policy.createPlan(owner, CAP, usd6(5000), 1000, listHash, ids, nonce, sig); // cap inflated
    }

    function test_createPlanMalformedSigRejected() public {
        string[] memory ids = demoIds();
        bytes32 listHash = keccak256(joinIds(ids));
        vm.expectRevert(RetenixPolicy.BadSignature.selector);
        policy.createPlan(owner, CAP, CAP, 1000, listHash, ids, 0, hex"deadbeef");
    }

    function test_createPlanGuards() public {
        string[] memory six = new string[](6);
        for (uint256 i = 0; i < 6; i++) six[i] = "a";
        vm.expectRevert(RetenixPolicy.TooManyAssets.selector);
        policy.createPlan(owner, CAP, CAP, 1000, bytes32(0), six, 0, new bytes(65));
        vm.expectRevert(RetenixPolicy.ZeroPeriod.selector);
        policy.createPlan(owner, CAP, CAP, 0, bytes32(0), demoIds(), 0, new bytes(65));
    }

    /// The signature commits to assetListHash; the plaintext ids must actually
    /// be its preimage or the relayer swapped the list.
    function test_createPlanListSwapRejected() public {
        string[] memory ids = demoIds();
        bytes32 listHash = keccak256(joinIds(ids));
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, createPlanDigest(agent, CAP, CAP, 1000, listHash, nonce));
        string[] memory swapped = new string[](1);
        swapped[0] = "memecoin";
        vm.expectRevert(RetenixPolicy.ListHashMismatch.selector);
        policy.createPlan(owner, CAP, CAP, 1000, listHash, swapped, nonce, sig);
    }

    function test_nonceIsSequentialAcrossOps() public {
        assertEq(policy.authNonces(owner), 0);
        uint256 id = createDemoPlan(CAP, CAP, 1000);
        assertEq(policy.authNonces(owner), 1);
        // stale (already-used) nonce for the next op is rejected
        bytes memory sig = sign(OWNER_PK, revokePlanDigest(id, 0));
        vm.expectRevert(RetenixPolicy.BadNonce.selector);
        policy.revokePlanFor(id, 0, sig);
        // future nonce equally rejected
        sig = sign(OWNER_PK, revokePlanDigest(id, 5));
        vm.expectRevert(RetenixPolicy.BadNonce.selector);
        policy.revokePlanFor(id, 5, sig);
    }

    function test_revokeAllWrongSignerRejected() public {
        createDemoPlan(CAP, CAP, 1000);
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(STRANGER_PK, revokeAllDigest(nonce));
        vm.expectRevert(RetenixPolicy.BadSignature.selector);
        policy.revokeAll(owner, nonce, sig);
    }

    function test_enrollEstateReplayAndReEnrollRejected() public {
        bytes32 beneficiaryHash = keccak256("heir@example.com|salt");
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, enrollEstateDigest(beneficiaryHash, 120, nonce));
        policy.enrollEstate(owner, beneficiaryHash, 120, nonce, sig);
        vm.expectRevert(RetenixPolicy.BadNonce.selector);
        policy.enrollEstate(owner, beneficiaryHash, 120, nonce, sig); // replay
        nonce = policy.authNonces(owner);
        sig = sign(OWNER_PK, enrollEstateDigest(beneficiaryHash, 120, nonce));
        vm.expectRevert(RetenixPolicy.AlreadyEnrolled.selector);
        policy.enrollEstate(owner, beneficiaryHash, 120, nonce, sig); // double enroll
    }

    function test_enrollEstateWrongSignerRejected() public {
        bytes32 beneficiaryHash = keccak256("heir@example.com|salt");
        bytes memory sig = sign(STRANGER_PK, enrollEstateDigest(beneficiaryHash, 120, 0));
        vm.expectRevert(RetenixPolicy.BadSignature.selector);
        policy.enrollEstate(owner, beneficiaryHash, 120, 0, sig);
    }

    // --- role fences ---
    function test_onlyAgentFence() public {
        uint256 id = createDemoPlan(CAP, CAP, 1000);
        vm.expectRevert(RetenixPolicy.NotAgent.selector);
        policy.recordExecution(id, usd6(1), SPYX);
        vm.expectRevert(RetenixPolicy.NotAgent.selector);
        policy.refundExecution(id, usd6(1));
    }

    function test_onlyOwnerFence() public {
        uint256 id = createDemoPlan(CAP, CAP, 1000);
        vm.startPrank(stranger);
        vm.expectRevert(RetenixPolicy.NotOwner.selector);
        policy.revokePlan(id);
        vm.expectRevert(RetenixPolicy.NotOwner.selector);
        policy.pausePlan(id);
        vm.expectRevert(RetenixPolicy.NotOwner.selector);
        policy.resumePlan(id);
        vm.stopPrank();
        // even the agent holds no owner powers
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotOwner.selector);
        policy.revokePlan(id);
    }

    function test_onlyRelayerFence() public {
        enrollDemoEstate(120);
        vm.expectRevert(RetenixPolicy.NotRelayer.selector);
        policy.checkIn(owner);
        vm.prank(owner); // not even the owner — check-ins are relayed (CONFLICTS #13)
        vm.expectRevert(RetenixPolicy.NotRelayer.selector);
        policy.checkIn(owner);
    }

    function test_onlyKeeperFence() public {
        enrollDemoEstate(120);
        vm.warp(block.timestamp + 121);
        policy.fireDeadline(owner);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.expectRevert(RetenixPolicy.NotKeeper.selector);
        policy.markClaimed(owner, stranger);
    }

    function test_onlyForwarderFence() public {
        enrollDemoEstate(120);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(RetenixPolicy.NotForwarder.selector);
        policy.performUpkeep(abi.encode(owner));
    }

    function test_fireDeadlineIsPermissionless() public {
        enrollDemoEstate(120);
        vm.warp(block.timestamp + 121);
        vm.prank(stranger); // liveness never depends on Retenix
        policy.fireDeadline(owner);
        assertEq(uint8(policy.estateStatus(owner)), uint8(RetenixPolicy.EstateStatus.Countdown));
    }

    function test_onlyAdminRoleSetters() public {
        vm.startPrank(stranger);
        vm.expectRevert(RetenixPolicy.NotAdmin.selector);
        policy.setRelayer(stranger);
        vm.expectRevert(RetenixPolicy.NotAdmin.selector);
        policy.setKeeper(stranger);
        vm.expectRevert(RetenixPolicy.NotAdmin.selector);
        policy.setAutomationForwarder(stranger);
        vm.stopPrank();
        // admin (deployer = this test) can rotate roles — the "transfer
        // relayer/keeper to production addresses" path
        vm.expectEmit(true, false, false, true);
        emit RetenixPolicy.RoleSet("relayer", stranger);
        policy.setRelayer(stranger);
        assertEq(policy.relayer(), stranger);
    }

    /// A compromised relayer can only relay owner-signed, nonce-bound payloads
    /// — with no signature it can do nothing but extend the owner's window.
    function test_compromisedRelayerBlastRadius() public {
        enrollDemoEstate(120);
        vm.startPrank(relayer);
        policy.checkIn(owner); // the only power: extend the window (safe direction)
        vm.expectRevert(RetenixPolicy.NotKeeper.selector);
        policy.markClaimed(owner, stranger);
        vm.expectRevert(RetenixPolicy.NotAdmin.selector);
        policy.setKeeper(relayer);
        vm.stopPrank();
    }
}
