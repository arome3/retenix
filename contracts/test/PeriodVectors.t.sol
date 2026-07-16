// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PolicyTestBase} from "./PolicyTestBase.sol";

/// Cross-impl guard (doc 08): the same hand-authored vectors that
/// packages/shared/src/period.test.ts asserts against the worker's
/// periodOf() are driven here through the REAL contract's lazy rollover in
/// recordExecution. Neither implementation generated the numbers — drift on
/// either side goes red.
contract PeriodVectors is PolicyTestBase {
    uint96 internal constant CAP = 50_000_000; // $50 caps; every vector records $1

    function test_vectorsMatchContractRollover() public {
        string memory json = vm.readFile("test/fixtures/period-vectors.json");
        uint256 n = vm.parseJsonUint(json, ".count");
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            uint256 anchor = vm.parseJsonUint(json, string.concat(p, ".anchor"));
            uint256 periodSecs = vm.parseJsonUint(json, string.concat(p, ".periodSecs"));
            uint256 nowTs = vm.parseJsonUint(json, string.concat(p, ".now"));
            uint256 expected = vm.parseJsonUint(json, string.concat(p, ".expectedPeriodStart"));
            string memory name = vm.parseJsonString(json, string.concat(p, ".name"));

            vm.warp(anchor); // plan's periodStart anchors to creation time
            uint256 id = createDemoPlan(CAP, CAP, uint32(periodSecs));
            vm.warp(nowTs);
            vm.prank(agent);
            policy.recordExecution(id, usd6(1), SPYX);
            assertEq(uint256(planPeriodStart(id)), expected, name);
        }
    }
}
