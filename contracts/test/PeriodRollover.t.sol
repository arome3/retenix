// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RetenixPolicy} from "../src/RetenixPolicy.sol";
import {PolicyTestBase} from "./PolicyTestBase.sol";

/// Family 2 — period rollover: warp across boundaries (including multi-period
/// gaps); spent resets; periodStart stays phase-aligned; boundary-exact
/// timestamps behave per the spec's `>=`.
contract PeriodRollover is PolicyTestBase {
    uint96 internal constant CAP = 50_000_000; // $50 exec + period
    uint32 internal constant PERIOD = 1000;

    uint256 internal planId;
    uint32 internal t0;

    function setUp() public override {
        super.setUp();
        t0 = uint32(block.timestamp);
        planId = createDemoPlan(CAP, CAP, PERIOD);
    }

    function test_withinPeriodAccumulates() public {
        vm.startPrank(agent);
        policy.recordExecution(planId, usd6(30), SPYX);
        vm.warp(t0 + PERIOD - 1); // last second of the period
        vm.expectRevert(RetenixPolicy.OverPeriodCap.selector);
        policy.recordExecution(planId, usd6(30), SPYX);
        vm.stopPrank();
        assertEq(planSpent(planId), usd6(30));
        assertEq(planPeriodStart(planId), t0);
    }

    function test_boundaryExactTimestampRolls() public {
        vm.prank(agent);
        policy.recordExecution(planId, usd6(30), SPYX);
        vm.warp(t0 + PERIOD); // exactly periodStart + periodSecs → new period (>=)
        vm.prank(agent);
        policy.recordExecution(planId, usd6(50), SPYX); // full cap available again
        assertEq(planSpent(planId), usd6(50));
        assertEq(planPeriodStart(planId), t0 + PERIOD);
    }

    function test_multiPeriodGapStaysPhaseAligned() public {
        vm.prank(agent);
        policy.recordExecution(planId, usd6(50), SPYX);
        vm.warp(t0 + 2 * PERIOD + 500); // skip 2½ periods
        vm.prank(agent);
        policy.recordExecution(planId, usd6(15), SPYX);
        // periodStart snaps to the CURRENT period's phase-aligned start, not `now`
        assertEq(planPeriodStart(planId), t0 + 2 * PERIOD);
        assertEq(planSpent(planId), usd6(15));
    }

    function test_spentResetsEachPeriod() public {
        for (uint32 i = 0; i < 5; i++) {
            vm.warp(t0 + i * PERIOD);
            vm.prank(agent);
            policy.recordExecution(planId, usd6(50), SPYX);
            assertEq(planSpent(planId), usd6(50));
        }
    }

    /// Rollover happens lazily inside recordExecution — a revert-then-retry in
    /// a fresh period must see the reset, and the reset must not double-count.
    function test_overCapThenNewPeriodSucceeds() public {
        vm.startPrank(agent);
        policy.recordExecution(planId, usd6(50), SPYX);
        vm.expectRevert(RetenixPolicy.OverPeriodCap.selector);
        policy.recordExecution(planId, usd6(1), SPYX);
        vm.warp(t0 + PERIOD + 1);
        policy.recordExecution(planId, usd6(1), SPYX);
        vm.stopPrank();
        assertEq(planSpent(planId), usd6(1));
        assertEq(planPeriodStart(planId), t0 + PERIOD);
    }

    function testFuzz_periodStartAlwaysPhaseAligned(uint32 gap, uint32 periodSecs) public {
        periodSecs = uint32(bound(periodSecs, 1, 365 days));
        gap = uint32(bound(gap, 0, 10 * uint256(periodSecs)));
        uint256 id = createDemoPlan(CAP, CAP, periodSecs);
        uint32 start0 = planPeriodStart(id);
        vm.warp(uint256(start0) + gap);
        vm.prank(agent);
        policy.recordExecution(id, usd6(1), TSLAX);
        uint32 start1 = planPeriodStart(id);
        assertEq((start1 - start0) % periodSecs, 0, "periodStart drifted off phase");
        assertLe(start1, block.timestamp);
        assertGt(uint256(start1) + periodSecs, block.timestamp, "current time outside its period");
    }

    /// Large-but-legit periodSecs must not overflow the uint32 boundary math
    /// (the widened uint256 comparison under test).
    function test_hugePeriodSecsDoesNotPanic() public {
        uint256 id = createDemoPlan(CAP, CAP, type(uint32).max);
        vm.warp(t0 + 365 days);
        vm.prank(agent);
        policy.recordExecution(id, usd6(15), SOL);
        assertEq(planPeriodStart(id), t0); // still the first (enormous) period
    }
}
