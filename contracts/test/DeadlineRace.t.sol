// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RetenixPolicy} from "../src/RetenixPolicy.sol";
import {PolicyTestBase} from "./PolicyTestBase.sol";

/// Family 4 — deadline/cancel races: fireDeadline vs checkIn/cancelClaim
/// orderings around lastCheckIn + inactivitySecs and claimReadyAt; owner
/// cancel wins any time before markClaimed; no early markClaimed.
contract DeadlineRace is PolicyTestBase {
    uint64 internal constant INACTIVITY = 120; // demo-scaled (tech spec §9)
    uint64 internal t0;

    function setUp() public override {
        super.setUp();
        t0 = uint64(block.timestamp);
        enrollDemoEstate(INACTIVITY);
    }

    function estStatus() internal view returns (RetenixPolicy.EstateStatus) {
        return policy.estateStatus(owner);
    }

    // --- deadline boundary (strict >) ---
    function test_fireBeforeDeadlineReverts() public {
        vm.warp(t0 + INACTIVITY); // exactly at the boundary — NOT due yet
        vm.expectRevert(RetenixPolicy.DeadlineNotDue.selector);
        policy.fireDeadline(owner);
    }

    function test_fireAfterDeadlineStartsCountdown() public {
        vm.warp(t0 + INACTIVITY + 1);
        vm.expectEmit(true, false, false, true);
        emit RetenixPolicy.DeadlineFired(owner, uint64(block.timestamp) + CHALLENGE_WINDOW);
        policy.fireDeadline(owner); // permissionless — this test contract is nobody special
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Countdown));
    }

    function test_fireTwiceReverts() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.expectRevert(RetenixPolicy.NotEnrolled.selector);
        policy.fireDeadline(owner); // already Countdown
    }

    // --- checkIn races (relayed liveness veto) ---
    function test_checkInResetsTheClock() public {
        vm.warp(t0 + INACTIVITY - 10);
        vm.prank(relayer);
        policy.checkIn(owner);
        vm.warp(t0 + INACTIVITY + 1); // past the ORIGINAL deadline…
        vm.expectRevert(RetenixPolicy.DeadlineNotDue.selector);
        policy.fireDeadline(owner); // …but the clock was reset
    }

    function test_checkInDuringCountdownVetoes() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.prank(relayer);
        policy.checkIn(owner); // Countdown → Enrolled, claimReadyAt cleared
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Enrolled));
        (,,,, uint64 claimReadyAt,) = policy.estates(owner);
        assertEq(claimReadyAt, 0);
        vm.prank(keeper);
        vm.expectRevert(RetenixPolicy.NotClaimable.selector);
        policy.markClaimed(owner, stranger);
    }

    /// The liveness veto works even after the window lapsed (estate reads
    /// Claimable) — the owner being alive beats the state machine until
    /// markClaimed actually lands.
    function test_checkInAfterClaimableStillRescues() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.warp(block.timestamp + CHALLENGE_WINDOW); // now Claimable
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Claimable));
        vm.prank(relayer);
        policy.checkIn(owner);
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Enrolled));
    }

    // --- claimReadyAt boundary ---
    function test_estateStatusFlipsExactlyAtClaimReadyAt() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        (,,,, uint64 claimReadyAt,) = policy.estates(owner);
        vm.warp(claimReadyAt - 1);
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Countdown));
        vm.warp(claimReadyAt);
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Claimable));
    }

    function test_markClaimedImpossibleBeforeClaimReadyAt() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        (,,,, uint64 claimReadyAt,) = policy.estates(owner);
        vm.warp(claimReadyAt - 1);
        vm.prank(keeper);
        vm.expectRevert(RetenixPolicy.NotClaimable.selector);
        policy.markClaimed(owner, stranger);
    }

    function test_markClaimedImpossibleWhileEnrolled() public {
        // a malicious keeper cannot shortcut time — no countdown ever fired
        vm.prank(keeper);
        vm.expectRevert(RetenixPolicy.NotClaimable.selector);
        policy.markClaimed(owner, stranger);
    }

    function test_happyClaimPath() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit RetenixPolicy.Claimed(owner, stranger);
        policy.markClaimed(owner, stranger);
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Claimed));
    }

    // --- cancel wins any time before markClaimed (the anti-hijack moment) ---
    function test_cancelFromEnrolled() public {
        vm.prank(owner);
        policy.cancelClaim();
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Cancelled));
        vm.expectRevert(RetenixPolicy.NotEnrolled.selector);
        policy.fireDeadline(owner); // cancelled estates can never fire
    }

    function test_cancelDuringCountdown() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.prank(owner);
        policy.cancelClaim();
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Cancelled));
        vm.prank(keeper);
        vm.expectRevert(RetenixPolicy.NotClaimable.selector);
        policy.markClaimed(owner, stranger);
    }

    function test_cancelAfterClaimableButBeforeMarkClaimedWins() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 30); // deep into Claimable
        vm.prank(owner);
        policy.cancelClaim(); // owner beats the keeper to the block
        vm.prank(keeper);
        vm.expectRevert(RetenixPolicy.NotClaimable.selector);
        policy.markClaimed(owner, stranger);
    }

    function test_cancelAfterMarkClaimedLoses() public {
        vm.warp(t0 + INACTIVITY + 1);
        policy.fireDeadline(owner);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.prank(keeper);
        policy.markClaimed(owner, stranger);
        vm.prank(owner);
        vm.expectRevert(RetenixPolicy.NotEnrolled.selector);
        policy.cancelClaim();
    }

    function test_reEnrollAfterCancel() public {
        vm.prank(owner);
        policy.cancelClaim();
        enrollDemoEstate(INACTIVITY); // fresh lifecycle, same owner
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Enrolled));
    }

    // --- Chainlink custom-logic upkeep (CONFLICTS #12) ---
    function test_checkUpkeepReportsDueEstate() public {
        vm.warp(t0 + INACTIVITY); // boundary — consistent with fireDeadline's strict >
        (bool needed,) = policy.checkUpkeep("");
        assertFalse(needed);
        vm.warp(t0 + INACTIVITY + 1);
        bytes memory performData;
        (needed, performData) = policy.checkUpkeep("");
        assertTrue(needed);
        assertEq(abi.decode(performData, (address)), owner);
    }

    function test_performUpkeepFiresViaForwarder() public {
        vm.warp(t0 + INACTIVITY + 1);
        (, bytes memory performData) = policy.checkUpkeep("");
        vm.prank(forwarder);
        policy.performUpkeep(performData);
        assertEq(uint8(estStatus()), uint8(RetenixPolicy.EstateStatus.Countdown));
    }

    /// performUpkeep revalidates: stale performData (owner checked in between
    /// simulation and execution) must revert, not fire.
    function test_performUpkeepRevalidatesCondition() public {
        vm.warp(t0 + INACTIVITY + 1);
        (, bytes memory performData) = policy.checkUpkeep("");
        vm.prank(relayer);
        policy.checkIn(owner); // the race: liveness lands first
        vm.prank(forwarder);
        vm.expectRevert(RetenixPolicy.DeadlineNotDue.selector);
        policy.performUpkeep(performData);
    }

    function test_checkUpkeepSkipsNonEnrolled() public {
        vm.prank(owner);
        policy.cancelClaim();
        vm.warp(t0 + 10 * INACTIVITY);
        (bool needed,) = policy.checkUpkeep("");
        assertFalse(needed);
    }
}
