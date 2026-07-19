// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {RetenixHedge} from "../src/RetenixHedge.sol";
import {HedgeTestBase} from "./HedgeTestBase.sol";

/// Fuzzer entry points for the stateful invariant run. Reverts are tolerated
/// (fail_on_revert=false) — the point is that NO interleaving of opens, closes,
/// pauses, revokes and time warps can leave an out-of-cap or long position, nor
/// one that cannot be closed.
contract HedgeFuzzHandler is CommonBase {
    RetenixHedge public immutable hedge;
    uint256 public immutable planId;
    address internal immutable agent;
    address internal immutable owner;

    bytes32 internal constant TSLA_PAIR = keccak256("TSLA/USD");

    constructor(RetenixHedge hedge_, uint256 planId_, address agent_, address owner_) {
        hedge = hedge_;
        planId = planId_;
        agent = agent_;
        owner = owner_;
    }

    function open(uint96 notional, uint16 lev, uint96 attested, uint32 age) external {
        uint64 attestedAt = uint64(block.timestamp) - uint64(age % 3600);
        vm.prank(agent);
        hedge.recordHedgeOpen(planId, notional, lev, TSLA_PAIR, attested, attestedAt);
    }

    function close() external {
        vm.prank(agent);
        hedge.recordHedgeClose(planId);
    }

    function pause() external {
        vm.prank(owner);
        hedge.pauseHedgePlan(planId);
    }

    function resume() external {
        vm.prank(owner);
        hedge.resumeHedgePlan(planId);
    }

    function revoke() external {
        vm.prank(owner);
        hedge.revokeHedgePlan(planId);
    }

    function warpForward(uint32 by) external {
        vm.warp(block.timestamp + (by % 10_000));
    }
}

/// doc 19 §Implementation guide, the five named invariants plus the two the
/// spec's own function list leaves unbounded (aggregate exposure, attestation
/// freshness). Onchain caps ARE the product — app-level checks are UX.
contract HedgeFuzz is HedgeTestBase {
    HedgeFuzzHandler internal handler;
    uint256 internal planId;

    uint96 internal constant CEILING = 500_000_000; // $500 owner-signed ceiling
    uint96 internal constant HOLDING = 800_000_000; // $800 attested holding

    function setUp() public override {
        super.setUp();
        planId = createDemoHedgePlan(CEILING, MAX_LEV_X10);
        handler = new HedgeFuzzHandler(hedge, planId, agent, owner);
        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // Invariant 1 — notional never exceeds the OWNER-SIGNED ceiling
    // ---------------------------------------------------------------------

    /// The unforgeable half of the cap: no interleaving may leave an open
    /// position above the ceiling the owner personally signed. A compromised
    /// agent key cannot raise this — only a fresh owner signature over a new
    /// plan can.
    function invariant_openNotionalNeverExceedsCeiling() public view {
        assertLe(hedge.openNotionalUsd6(planId), CEILING, "open notional exceeded owner ceiling");
    }

    /// The attestation may only ever TIGHTEN the ceiling, never widen it.
    /// Fuzzing both sides proves the min() rather than assuming it.
    function testFuzz_notionalNeverExceedsAttestedCap(uint96 notional, uint96 attested) public {
        attested = uint96(bound(attested, 1, type(uint96).max));
        notional = uint96(bound(notional, 1, type(uint96).max));
        uint96 cap = attested < CEILING ? attested : CEILING;

        vm.prank(agent);
        if (notional > cap) {
            vm.expectRevert(RetenixHedge.OverNotionalCap.selector);
            hedge.recordHedgeOpen(planId, notional, 10, TSLA_PAIR, attested, uint64(block.timestamp));
            assertEq(hedge.openNotionalUsd6(planId), 0, "rejected open must leave the plan flat");
        } else {
            hedge.recordHedgeOpen(planId, notional, 10, TSLA_PAIR, attested, uint64(block.timestamp));
            assertEq(hedge.openNotionalUsd6(planId), notional, "accepted open must be recorded");
        }
    }

    /// A holding value of zero can never justify a position.
    function testFuzz_zeroAttestationAlwaysRejected(uint96 notional) public {
        notional = uint96(bound(notional, 1, CEILING));
        vm.prank(agent);
        vm.expectRevert(RetenixHedge.ZeroHolding.selector);
        hedge.recordHedgeOpen(planId, notional, 10, TSLA_PAIR, 0, uint64(block.timestamp));
    }

    /// Freshness: a stale attestation is a replayed high-water mark (the
    /// holding may have halved since), and a FUTURE-dated one is a forgery
    /// signal — the exact shape of the oracle attack that took Ostium down.
    function testFuzz_staleOrFutureAttestationRejected(uint64 attestedAt) public {
        uint64 nowSec = uint64(block.timestamp);
        bool fresh = attestedAt <= nowSec && nowSec - attestedAt <= ATTESTATION_MAX_AGE;
        vm.assume(!fresh);

        vm.prank(agent);
        vm.expectRevert(RetenixHedge.StaleAttestation.selector);
        hedge.recordHedgeOpen(planId, usd6(10), 10, TSLA_PAIR, HOLDING, attestedAt);
    }

    // ---------------------------------------------------------------------
    // Invariant 2 — leverage never exceeds 2.0x (x10 units: 20)
    // ---------------------------------------------------------------------

    /// NOTE THE UNITS. maxLeverageX10 is x10 fixed-point, so the ceiling is
    /// 20, not 2 — an off-by-ten here ships a 20x hedge wearing a 2x label.
    function testFuzz_leverageNeverExceedsCap(uint16 levX10) public {
        vm.prank(agent);
        if (levX10 == 0) {
            vm.expectRevert(RetenixHedge.ZeroLeverage.selector);
        } else if (levX10 > MAX_LEV_X10) {
            vm.expectRevert(RetenixHedge.OverLeverageCap.selector);
        }
        hedge.recordHedgeOpen(planId, usd6(10), levX10, TSLA_PAIR, HOLDING, uint64(block.timestamp));
        if (levX10 != 0 && levX10 <= MAX_LEV_X10) {
            assertEq(hedge.openNotionalUsd6(planId), usd6(10), "in-cap leverage must open");
        }
    }

    /// The ceiling cannot be widened at creation either — otherwise a plan
    /// could be born holding a 5x cap and every later check would honour it.
    function testFuzz_createRejectsLeverageAboveGlobalCap(uint16 levX10) public {
        vm.assume(levX10 > MAX_LEV_X10);
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, levX10, nonce));
        vm.expectRevert(RetenixHedge.OverLeverageCap.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING, levX10, SHORT_ONLY, nonce, sig);
    }

    /// A plan's own cap binds even when it is below the global ceiling.
    function test_perPlanLeverageCapBindsBelowGlobalCeiling() public {
        uint256 id = createDemoHedgePlan(CEILING, 10); // this plan maxes at 1.0x
        vm.prank(agent);
        vm.expectRevert(RetenixHedge.OverLeverageCap.selector);
        hedge.recordHedgeOpen(id, usd6(10), 20, TSLA_PAIR, HOLDING, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Invariant 3 — direction is locked SHORT_ONLY
    // ---------------------------------------------------------------------

    /// Never a long. A non-zero direction fails LOUDLY at creation rather than
    /// being silently rewritten into a short.
    function testFuzz_directionShortOnly(uint8 direction) public {
        vm.assume(direction != SHORT_ONLY);
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        vm.expectRevert(RetenixHedge.WrongDirection.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING, MAX_LEV_X10, direction, nonce, sig);
    }

    /// Stateful: no reachable state has a non-short plan.
    function invariant_everyPlanIsShortOnly() public view {
        assertEq(planDirection(planId), SHORT_ONLY, "a plan escaped SHORT_ONLY");
    }

    // ---------------------------------------------------------------------
    // Invariant 4 — a revoked plan rejects opens
    // ---------------------------------------------------------------------

    function testFuzz_revokedPlanRejectsOpen(uint96 notional, uint16 lev) public {
        notional = uint96(bound(notional, 1, CEILING));
        lev = uint16(bound(lev, 1, MAX_LEV_X10));
        revokeAsOwner(planId);

        vm.prank(agent);
        vm.expectRevert(RetenixHedge.NotActive.selector);
        hedge.recordHedgeOpen(planId, notional, lev, TSLA_PAIR, HOLDING, uint64(block.timestamp));
    }

    function testFuzz_pausedPlanRejectsOpen(uint96 notional) public {
        notional = uint96(bound(notional, 1, CEILING));
        pauseAsOwner(planId);

        vm.prank(agent);
        vm.expectRevert(RetenixHedge.NotActive.selector);
        hedge.recordHedgeOpen(planId, notional, 10, TSLA_PAIR, HOLDING, uint64(block.timestamp));
    }

    function test_revokeAllHedgesRejectsSubsequentOpens() public {
        uint256 second = createDemoHedgePlan(CEILING, MAX_LEV_X10);
        uint256 nonce = hedge.authNonces(owner);
        hedge.revokeAllHedges(owner, nonce, sign(OWNER_PK, revokeAllHedgesDigest(nonce)));

        for (uint256 i = 0; i < 2; i++) {
            uint256 id = i == 0 ? planId : second;
            vm.prank(agent);
            vm.expectRevert(RetenixHedge.NotActive.selector);
            hedge.recordHedgeOpen(id, usd6(10), 10, TSLA_PAIR, HOLDING, uint64(block.timestamp));
        }
    }

    // ---------------------------------------------------------------------
    // Invariant 5 — close is NEVER gated (the kill-switch guarantee)
    // ---------------------------------------------------------------------

    /// PS-F12-AC4 / doc 13's "can never block your kill switch". Whatever the
    /// plan's status — including revoked, which revokeAllHedges sets BEFORE the
    /// kill switch closes anything — the agent can always flatten the position.
    /// If this test ever needs an exception, the kill switch is broken.
    function testFuzz_closeNeverGatedByStatus(uint8 statusPath) public {
        openFresh(planId, usd6(100), 10, HOLDING);
        assertEq(hedge.openNotionalUsd6(planId), usd6(100), "precondition: position open");

        uint8 path = statusPath % 3;
        if (path == 1) pauseAsOwner(planId);
        if (path == 2) revokeAsOwner(planId);

        vm.prank(agent);
        hedge.recordHedgeClose(planId); // must not revert on ANY path
        assertEq(hedge.openNotionalUsd6(planId), 0, "close must flatten on every status path");
    }

    /// Revoke-while-open is the exact kill-switch ordering: revokeAllHedges
    /// runs first, then the closes. A status gate here would strand the
    /// position at precisely the moment the user asked for everything out.
    function test_revokeAllThenCloseStillFlattens() public {
        openFresh(planId, usd6(100), 10, HOLDING);
        uint256 nonce = hedge.authNonces(owner);
        hedge.revokeAllHedges(owner, nonce, sign(OWNER_PK, revokeAllHedgesDigest(nonce)));

        vm.prank(agent);
        hedge.recordHedgeClose(planId);
        assertEq(hedge.openNotionalUsd6(planId), 0, "kill ordering must still flatten");
    }

    /// Idempotent by design: the kill path retries blindly, so a second close
    /// must be a silent no-op rather than a revert that reads as a failure.
    function test_closeIsIdempotent() public {
        openFresh(planId, usd6(100), 10, HOLDING);

        vm.prank(agent);
        hedge.recordHedgeClose(planId);
        vm.prank(agent);
        hedge.recordHedgeClose(planId); // no revert
        assertEq(hedge.openNotionalUsd6(planId), 0, "still flat");
    }

    /// Closing a flat plan is a no-op, not an error — the kill path may not
    /// know whether a hedge was ever opened.
    function test_closeOnFlatPlanIsNoOp() public {
        vm.prank(agent);
        hedge.recordHedgeClose(planId);
        assertEq(hedge.openNotionalUsd6(planId), 0, "still flat");
    }

    // ---------------------------------------------------------------------
    // Aggregate exposure — the bound doc 19's three functions do not provide
    // ---------------------------------------------------------------------

    /// Without AlreadyOpen(), an agent could call recordHedgeOpen N times,
    /// each individually within cap, for N x ceiling of total short. The
    /// ceiling would then mean nothing a reader assumes it means.
    function test_secondOpenWhileOpenReverts() public {
        openFresh(planId, usd6(100), 10, HOLDING);
        vm.prank(agent);
        vm.expectRevert(RetenixHedge.AlreadyOpen.selector);
        hedge.recordHedgeOpen(planId, usd6(100), 10, TSLA_PAIR, HOLDING, uint64(block.timestamp));
    }

    /// ...and after a close the plan is reusable, so the guard bounds
    /// CONCURRENT exposure without permanently retiring the plan.
    function test_reopenAfterCloseIsAllowed() public {
        openFresh(planId, usd6(100), 10, HOLDING);
        vm.prank(agent);
        hedge.recordHedgeClose(planId);
        openFresh(planId, usd6(100), 10, HOLDING);
        assertEq(hedge.openNotionalUsd6(planId), usd6(100), "plan reusable after close");
    }

    // ---------------------------------------------------------------------
    // No-panic discipline (family 1's rule, carried over)
    // ---------------------------------------------------------------------

    /// Every rejection must be a NAMED custom error, never Panic(0x11) from an
    /// unchecked subtraction at a uint96/uint64 boundary.
    function testFuzz_noPanicAtBounds(uint96 notional, uint96 attested, uint16 lev, uint64 attestedAt)
        public
    {
        vm.prank(agent);
        try hedge.recordHedgeOpen(planId, notional, lev, TSLA_PAIR, attested, attestedAt) {
            // accepted — must be within every cap
            assertLe(hedge.openNotionalUsd6(planId), CEILING, "accepted open above ceiling");
            assertLe(lev, MAX_LEV_X10, "accepted open above leverage cap");
        } catch (bytes memory reason) {
            assertEq(reason.length, 4, "rejection must be a 4-byte custom error, never a Panic");
        }
    }
}
