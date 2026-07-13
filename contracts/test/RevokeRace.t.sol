// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RetenixPolicy} from "../src/RetenixPolicy.sol";
import {PolicyTestBase} from "./PolicyTestBase.sol";

/// Family 3 — revoke-mid-execution race: a revoke landing between the agent's
/// view-check and its recordExecution MUST revert NotActive at the contract.
/// (Revoke after recordExecution but before UA send is module 08's pipeline
/// test — here we prove only the contract-side revert.)
contract RevokeRace is PolicyTestBase {
    uint96 internal constant CAP = 50_000_000; // $50
    uint256 internal planId;

    function setUp() public override {
        super.setUp();
        planId = createDemoPlan(CAP, CAP, 604_800);
    }

    function test_revokeBetweenViewCheckAndRecordReverts() public {
        // agent's preflight view-check sees an Active plan…
        assertEq(planStatus(planId), uint8(RetenixPolicy.PlanStatus.Active));
        // …the owner's revoke lands first…
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit RetenixPolicy.PlanRevoked(planId);
        policy.revokePlan(planId);
        // …and the agent's recordExecution hits the ledger, not the stale view
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.recordExecution(planId, usd6(15), SPYX);
    }

    function test_pauseBlocksExecutionResumeRestores() public {
        vm.prank(owner);
        policy.pausePlan(planId);
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.recordExecution(planId, usd6(15), SPYX);
        vm.prank(owner);
        policy.resumePlan(planId);
        vm.prank(agent);
        policy.recordExecution(planId, usd6(15), SPYX);
        assertEq(planSpent(planId), usd6(15));
    }

    /// PS-F5-AC2 / F6: one transaction zeroes the agent's authority across
    /// every plan the owner holds — active, paused, all of them.
    function test_revokeAllZeroesAuthorityInOneTx() public {
        uint256 second = createDemoPlan(CAP, CAP, 604_800);
        uint256 third = createDemoPlan(CAP, CAP, 604_800);
        vm.prank(owner);
        policy.pausePlan(third); // paused plans must be revoked too
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, revokeAllDigest(nonce));
        policy.revokeAll(owner, nonce, sig); // relayed — one tx
        uint256[3] memory ids = [planId, second, third];
        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(planStatus(ids[i]), uint8(RetenixPolicy.PlanStatus.Revoked));
            vm.prank(agent);
            vm.expectRevert(RetenixPolicy.NotActive.selector);
            policy.recordExecution(ids[i], usd6(1), SPYX);
        }
    }

    function test_revokeAllSkipsAlreadyRevoked() public {
        uint256 second = createDemoPlan(CAP, CAP, 604_800);
        vm.prank(owner);
        policy.revokePlan(planId);
        uint256 nonce = policy.authNonces(owner);
        policy.revokeAll(owner, nonce, sign(OWNER_PK, revokeAllDigest(nonce)));
        assertEq(planStatus(planId), uint8(RetenixPolicy.PlanStatus.Revoked));
        assertEq(planStatus(second), uint8(RetenixPolicy.PlanStatus.Revoked));
    }

    function test_revokedPlanCannotBeResumedOrReRevoked() public {
        vm.startPrank(owner);
        policy.revokePlan(planId);
        vm.expectRevert(RetenixPolicy.NotPaused.selector);
        policy.resumePlan(planId);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.revokePlan(planId);
        vm.stopPrank();
    }

    function test_relayedRevokePlanFor() public {
        uint256 nonce = policy.authNonces(owner);
        bytes memory sig = sign(OWNER_PK, revokePlanDigest(planId, nonce));
        policy.revokePlanFor(planId, nonce, sig); // anyone may submit
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.recordExecution(planId, usd6(15), SPYX);
    }

    /// PlanStatus.Active == 0, so an uninitialized plan's status READS Active;
    /// the existence check must make nonexistent ids revert NotActive.
    function test_nonexistentPlanRevertsNotActive() public {
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.recordExecution(999, usd6(15), SPYX);
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.refundExecution(999, usd6(15));
    }

    /// The demo-beat-5 ledger sequence, contract-side (PS-F5-AC1): ok →
    /// AssetNotAllowed → OverPeriodCap → revoke → NotActive.
    function test_demoBeat5Sequence() public {
        vm.prank(agent);
        policy.recordExecution(planId, usd6(15), SPYX); // $15 SPYx — ok
        // the spec'd check order is exec cap → period cap → allowlist, so the
        // doc's "$500 memecoin" beat reverts OverExecCap; a within-caps amount
        // is what demonstrates AssetNotAllowed (deviation noted in HANDOFF)
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.AssetNotAllowed.selector);
        policy.recordExecution(planId, usd6(30), MEMECOIN); // caps ok, asset not on the list
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.OverExecCap.selector);
        policy.recordExecution(planId, usd6(500), MEMECOIN); // $500 > $50/exec blocked first
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.OverPeriodCap.selector);
        policy.recordExecution(planId, usd6(45), SPYX); // $15 + $45 > $50/period
        vm.prank(owner);
        policy.revokePlan(planId);
        vm.prank(agent);
        vm.expectRevert(RetenixPolicy.NotActive.selector);
        policy.recordExecution(planId, usd6(1), SPYX);
    }
}
