// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RetenixHedge} from "../src/RetenixHedge.sol";
import {HedgeTestBase} from "./HedgeTestBase.sol";

/// Auth fences for RetenixHedge (doc 19). Mirrors AuthTest.t.sol's posture:
/// every privileged entry point is probed from every wrong caller, every
/// relayed signature is probed with the wrong signer / a replayed nonce / a
/// tampered parameter, and the domain separation from RetenixPolicy is pinned.
contract HedgeAuthTest is HedgeTestBase {
    uint256 internal planId;

    uint96 internal constant CEILING = 500_000_000; // $500
    uint96 internal constant HOLDING = 800_000_000; // $800

    function setUp() public override {
        super.setUp();
        planId = createDemoHedgePlan(CEILING, MAX_LEV_X10);
    }

    // --- agent-only surfaces --------------------------------------------

    function test_openRejectsEveryNonAgentCaller() public {
        address[3] memory callers = [owner, stranger, address(this)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(RetenixHedge.NotAgent.selector);
            hedge.recordHedgeOpen(planId, usd6(10), 10, TSLA_PAIR, HOLDING, uint64(block.timestamp));
        }
    }

    /// Close is ungated by STATUS, never by CALLER — the two are different
    /// properties and conflating them would let anyone flatten a stranger's
    /// protection.
    function test_closeIsUngatedByStatusButNotByCaller() public {
        openFresh(planId, usd6(100), 10, HOLDING);
        address[3] memory callers = [owner, stranger, address(this)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(RetenixHedge.NotAgent.selector);
            hedge.recordHedgeClose(planId);
        }
        assertEq(hedge.openNotionalUsd6(planId), usd6(100), "position survived the wrong callers");
    }

    function test_openOnNonexistentPlanReverts() public {
        vm.prank(agent);
        vm.expectRevert(RetenixHedge.NotActive.selector);
        hedge.recordHedgeOpen(999, usd6(10), 10, TSLA_PAIR, HOLDING, uint64(block.timestamp));
    }

    function test_closeOnNonexistentPlanReverts() public {
        vm.prank(agent);
        vm.expectRevert(RetenixHedge.NotActive.selector);
        hedge.recordHedgeClose(999);
    }

    // --- owner-only surfaces --------------------------------------------

    function test_pauseResumeRevokeRejectNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(RetenixHedge.NotOwner.selector);
        hedge.pauseHedgePlan(planId);

        vm.prank(stranger);
        vm.expectRevert(RetenixHedge.NotOwner.selector);
        hedge.revokeHedgePlan(planId);

        pauseAsOwner(planId);
        vm.prank(stranger);
        vm.expectRevert(RetenixHedge.NotOwner.selector);
        hedge.resumeHedgePlan(planId);
    }

    function test_agentCannotRevokeOrPause() public {
        vm.prank(agent);
        vm.expectRevert(RetenixHedge.NotOwner.selector);
        hedge.revokeHedgePlan(planId);
    }

    // --- relayed signature fences ---------------------------------------

    function test_createRejectsWrongSigner() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(STRANGER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
    }

    /// The owner signs the CEILING. A relayer that substitutes a bigger one
    /// breaks the digest — this is what makes layer 1 unforgeable.
    function test_createRejectsTamperedCeiling() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING * 10, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
    }

    function test_createRejectsTamperedHoldingId() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.createHedgePlan(owner, SPYX, CEILING, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
    }

    function test_createRejectsReplayedNonce() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        hedge.createHedgePlan(owner, TSLAX, CEILING, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
        vm.expectRevert(RetenixHedge.BadNonce.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
    }

    function test_revokeForRejectsWrongSigner() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig = sign(STRANGER_PK, revokeHedgePlanDigest(planId, nonce));
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.revokeHedgePlanFor(planId, nonce, sig);
    }

    function test_revokeAllRejectsWrongSigner() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig = sign(STRANGER_PK, revokeAllHedgesDigest(nonce));
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.revokeAllHedges(owner, nonce, sig);
    }

    function test_malformedSignatureLengthReverts() public {
        uint256 nonce = hedge.authNonces(owner);
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.revokeHedgePlanFor(planId, nonce, hex"deadbeef");
    }

    // --- domain separation ----------------------------------------------

    /// Every digest binds address(this), so a signature minted for the POLICY
    /// contract is worthless here and vice versa. This is why the separate
    /// nonce space is safe — but also why a relay helper must read its nonce
    /// from the contract it is about to call.
    function test_signatureFromAnotherDeploymentIsRejected() public {
        RetenixHedge other = new RetenixHedge(agent, ATTESTATION_MAX_AGE);
        uint256 nonce = hedge.authNonces(owner);
        bytes32 foreignDigest = keccak256(abi.encode(
            block.chainid, address(other), "createHedgePlan",
            agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        bytes memory sig = sign(OWNER_PK, foreignDigest);
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
    }

    function test_signatureFromAnotherChainIsRejected() public {
        uint256 nonce = hedge.authNonces(owner);
        bytes memory sig =
            sign(OWNER_PK, createHedgePlanDigest(agent, TSLAX, CEILING, MAX_LEV_X10, nonce));
        vm.chainId(1); // same params, different chain
        vm.expectRevert(RetenixHedge.BadSignature.selector);
        hedge.createHedgePlan(owner, TSLAX, CEILING, MAX_LEV_X10, SHORT_ONLY, nonce, sig);
    }

    /// The nonce space is per-contract; a fresh deployment starts at zero.
    function test_nonceSpaceIsPerContract() public {
        assertEq(hedge.authNonces(owner), 1, "one plan created in setUp");
        RetenixHedge other = new RetenixHedge(agent, ATTESTATION_MAX_AGE);
        assertEq(other.authNonces(owner), 0, "a sibling deployment starts fresh");
    }

    // --- enumeration ------------------------------------------------------

    function test_hedgePlansOfEnumeratesForKillSwitch() public {
        createDemoHedgePlan(CEILING, MAX_LEV_X10);
        assertEq(hedge.hedgePlanCountOf(owner), 2, "owner enumeration must see both plans");
        assertEq(hedge.hedgePlanCountOf(stranger), 0, "strangers own nothing");
    }

    function test_doubleRevokeReverts() public {
        revokeAsOwner(planId);
        vm.prank(owner);
        vm.expectRevert(RetenixHedge.NotActive.selector);
        hedge.revokeHedgePlan(planId);
    }
}
