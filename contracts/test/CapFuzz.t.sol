// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {RetenixPolicy} from "../src/RetenixPolicy.sol";
import {PolicyTestBase} from "./PolicyTestBase.sol";

/// Fuzzer entry points for the stateful invariant run. Every call is made as
/// the agent; reverts are tolerated (fail_on_revert=false) — the point is that
/// NO interleaving of records/refunds/warps can push spentInPeriod over cap.
contract CapFuzzHandler is CommonBase {
    RetenixPolicy public immutable policy;
    uint256 public immutable planId;
    address internal immutable agent;

    bytes32 internal constant SPYX = keccak256("spyx");
    bytes32 internal constant TSLAX = keccak256("tslax");
    bytes32 internal constant MEMECOIN = keccak256("memecoin"); // not allowlisted

    constructor(RetenixPolicy policy_, uint256 planId_, address agent_) {
        policy = policy_;
        planId = planId_;
        agent = agent_;
    }

    function record(uint96 usd, uint8 assetSel) external {
        bytes32 asset = assetSel % 3 == 0 ? SPYX : assetSel % 3 == 1 ? TSLAX : MEMECOIN;
        vm.prank(agent);
        policy.recordExecution(planId, usd, asset);
    }

    function refund(uint96 usd) external {
        vm.prank(agent);
        policy.refundExecution(planId, usd);
    }

    function warpForward(uint32 by) external {
        vm.warp(block.timestamp + (by % 10_000));
    }
}

/// Family 1 — cap-arithmetic fuzzing (tech spec §6 / doc 07):
/// spentInPeriod ≤ capPerPeriod always; single exec ≤ capPerExec; no overflow
/// panics at uint96 bounds; usd6 vectors match the TS encoder (CONFLICTS #11).
contract CapFuzz is PolicyTestBase {
    CapFuzzHandler internal handler;
    uint256 internal planId;

    uint96 internal constant CAP_EXEC = 50_000_000; // $50
    uint96 internal constant CAP_PERIOD = 120_000_000; // $120
    uint32 internal constant PERIOD = 1000;

    function setUp() public override {
        super.setUp();
        planId = createDemoPlan(CAP_EXEC, CAP_PERIOD, PERIOD);
        handler = new CapFuzzHandler(policy, planId, agent);
        targetContract(address(handler));
    }

    /// The contract's law: no interleaving of executions, refunds, and time
    /// warps may ever leave more than capPerPeriod recorded for the period.
    function invariant_spentNeverExceedsPeriodCap() public view {
        assertLe(planSpent(planId), CAP_PERIOD, "spentInPeriod exceeded capPerPeriod");
    }

    /// Single-exec gate: anything above capPerExec reverts OverExecCap, always.
    function testFuzz_execCapEnforced(uint96 usd) public {
        vm.prank(agent);
        if (usd > CAP_EXEC) {
            vm.expectRevert(RetenixPolicy.OverExecCap.selector);
            policy.recordExecution(planId, usd, SPYX);
        } else {
            policy.recordExecution(planId, usd, SPYX);
            assertEq(planSpent(planId), usd);
            assertLe(planSpent(planId), CAP_PERIOD);
        }
    }

    /// Arbitrary sequences: every accepted execution keeps the running total
    /// within capPerPeriod; every rejection is a named custom error.
    function testFuzz_sequenceNeverExceedsPeriodCap(uint96[] calldata amounts) public {
        uint256 accepted;
        for (uint256 i = 0; i < amounts.length && i < 32; i++) {
            vm.prank(agent);
            try policy.recordExecution(planId, amounts[i], TSLAX) {
                accepted += amounts[i];
                assertEq(planSpent(planId), accepted);
                assertLe(accepted, CAP_PERIOD);
            } catch (bytes memory err) {
                _assertNamedCapError(err);
            }
        }
    }

    /// uint96-boundary caps and amounts: reverts are OverExecCap/OverPeriodCap,
    /// never Panic(0x11) — the widened comparison under test. Also proves a
    /// second exec cannot overflow spent past the cap at the type boundary.
    function testFuzz_noPanicAtUint96Bounds(uint96 capPerExec, uint96 capPerPeriod, uint96 a, uint96 b)
        public
    {
        uint256 id = createDemoPlan(capPerExec, capPerPeriod, PERIOD);
        vm.startPrank(agent);
        _recordExpectingCapErrors(id, a, capPerExec, capPerPeriod);
        _recordExpectingCapErrors(id, b, capPerExec, capPerPeriod);
        vm.stopPrank();
        assertLe(planSpent(id), capPerPeriod);
    }

    /// Refunds credit the period and clamp at zero — they can never mint
    /// negative spend or extra headroom beyond a fresh period.
    function testFuzz_refundClampsAtZero(uint96 spend, uint96 refundAmt) public {
        spend = uint96(bound(spend, 0, CAP_EXEC));
        vm.startPrank(agent);
        policy.recordExecution(planId, spend, SPYX);
        policy.refundExecution(planId, refundAmt);
        vm.stopPrank();
        uint96 expected = refundAmt >= spend ? 0 : spend - refundAmt;
        assertEq(planSpent(planId), expected);
    }

    /// usd6 vectors (CONFLICTS #11): the TS encoder's output must equal the
    /// micro-USD integers the contract compares against — a 2-dp/6-dp mismatch
    /// would silently multiply caps by 10^4.
    function test_usd6VectorsMatchTsEncoder() public view {
        string memory json = vm.readFile("test/fixtures/policy-vectors.json");
        assertEq(vm.parseJsonUint(json, ".usd6.usd15"), 15_000_000);
        assertEq(vm.parseJsonUint(json, ".usd6.usd45"), 45_000_000);
        assertEq(vm.parseJsonUint(json, ".usd6.usd50"), 50_000_000);
        assertEq(vm.parseJsonUint(json, ".usd6.usd500"), 500_000_000);
        assertEq(vm.parseJsonUint(json, ".usd6.cents1"), 10_000);
        assertEq(vm.parseJsonUint(json, ".usd6.usd50"), usd6(50));
    }

    function _recordExpectingCapErrors(uint256 id, uint96 usd, uint96 capPerExec, uint96 capPerPeriod)
        internal
    {
        uint96 before = planSpent(id);
        try policy.recordExecution(id, usd, SOL) {
            assertLe(uint256(before) + usd, capPerPeriod);
        } catch (bytes memory err) {
            _assertNamedCapError(err);
            if (bytes4(err) == RetenixPolicy.OverExecCap.selector) assertGt(usd, capPerExec);
            if (bytes4(err) == RetenixPolicy.OverPeriodCap.selector) {
                assertGt(uint256(before) + usd, capPerPeriod);
            }
        }
    }

    function _assertNamedCapError(bytes memory err) internal pure {
        bytes4 sel = bytes4(err);
        assertTrue(
            sel == RetenixPolicy.OverExecCap.selector || sel == RetenixPolicy.OverPeriodCap.selector
                || sel == RetenixPolicy.AssetNotAllowed.selector,
            "revert was not a named cap/allowlist error (Panic?)"
        );
    }
}
