// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PolicyTestBase} from "./PolicyTestBase.sol";
import {RetenixClaim} from "../src/RetenixClaim.sol";
import {RetenixPolicy} from "../src/RetenixPolicy.sol";

/// Mocks — minimal on purpose; each models one real-world token behavior the
/// claim path must survive.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// USDT-style: transfer returns nothing.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// Broken/blocklisting token: transfer returns false instead of reverting.
contract FalseReturnERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// A heir that cannot receive native — documents the atomicity policy
/// (NativeSweepFailed keeps the claim loud, never a silent partial payout).
contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

/// Doc 14 family — RetenixClaim, the minimal transfer-out 7702 delegate.
/// Delegated-context tests use vm.signAndAttachDelegation (forge-std 7702
/// cheatcodes); protocol-level tuple staleness (a stale authorization being
/// silently SKIPPED by a real node) cannot revert here by design — that
/// property is proven by the anvil rehearsal (apps/worker/scripts/rehearse-g4.ts).
contract ClaimDelegateTest is PolicyTestBase {
    RetenixClaim internal claimImpl;    // policy-less (non-Arbitrum posture)
    RetenixClaim internal claimArb;     // policy-gated (Arbitrum posture)

    uint256 internal constant OWNER2_PK = 0xC0FFEE;
    address internal owner2;
    address internal heir;

    function setUp() public override {
        super.setUp();
        owner2 = vm.addr(OWNER2_PK);
        heir = makeAddr("heir");
        claimImpl = new RetenixClaim(keeper, address(0));
        claimArb = new RetenixClaim(keeper, address(policy));
    }

    // --- helpers ---

    function enrollEstateFor(uint256 pk, uint64 inactivitySecs) internal {
        address estateOwner = vm.addr(pk);
        bytes32 beneficiaryHash = keccak256("heir@example.com|salt");
        uint256 nonce = policy.authNonces(estateOwner);
        bytes memory sig = sign(pk, keccak256(abi.encode(
            block.chainid, address(policy), "enrollEstate", beneficiaryHash, inactivitySecs, nonce)));
        policy.enrollEstate(estateOwner, beneficiaryHash, inactivitySecs, nonce, sig);
    }

    /// Drive an estate to the stored-Countdown-past-window state (reads Claimable).
    function driveToClaimable(uint256 pk) internal {
        enrollEstateFor(pk, 120);
        vm.warp(block.timestamp + 121);
        policy.fireDeadline(vm.addr(pk));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
    }

    function delegated(address who) internal pure returns (RetenixClaim) {
        return RetenixClaim(payable(who));
    }

    // --- constructor guards ---

    function test_constructorRejectsZeroKeeper() public {
        vm.expectRevert(RetenixClaim.NotKeeper.selector);
        new RetenixClaim(address(0), address(0));
    }

    function test_constructorRequiresPolicyOnArbitrum() public {
        uint256 prev = block.chainid;
        vm.chainId(42161);
        vm.expectRevert(RetenixClaim.PolicyRequired.selector);
        new RetenixClaim(keeper, address(0));
        RetenixClaim ok = new RetenixClaim(keeper, address(policy));
        assertEq(ok.policy(), address(policy));
        vm.chainId(prev);
    }

    // --- keeper gating ---

    function test_registerHeirOnlyKeeper() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(stranger);
        vm.expectRevert(RetenixClaim.NotKeeper.selector);
        delegated(owner).registerHeir(owner, heir);
    }

    function test_claimOnlyKeeper() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(stranger);
        vm.expectRevert(RetenixClaim.NotKeeper.selector);
        delegated(owner).claim(owner, new address[](0));
    }

    // --- context assertion (keeper software bugs must revert loudly) ---

    function test_registerHeirAtSingletonRevertsWrongContext() public {
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.WrongContext.selector);
        claimImpl.registerHeir(owner, heir);
    }

    function test_claimAtSingletonRevertsWrongContext() public {
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.WrongContext.selector);
        claimImpl.claim(owner, new address[](0));
    }

    function test_delegatedMismatchedOwnerParamRevertsWrongContext() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.WrongContext.selector);
        delegated(owner).registerHeir(owner2, heir);
    }

    // --- one-shot registration ---

    function test_registerHeirIsOneShot() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);
        assertEq(delegated(owner).heirOf(owner), heir);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.AlreadyRegistered.selector);
        delegated(owner).registerHeir(owner, makeAddr("other-heir"));
    }

    function test_registerHeirRejectsZeroHeir() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.ZeroHeir.selector);
        delegated(owner).registerHeir(owner, address(0));
    }

    // --- storage isolation: heirOf lives in EACH owner's storage ---

    function test_heirStorageIsPerOwnerNotSingleton() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.signAndAttachDelegation(address(claimImpl), OWNER2_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);

        assertEq(delegated(owner).heirOf(owner), heir);
        assertEq(claimImpl.heirOf(owner), address(0), "singleton storage untouched");
        assertEq(delegated(owner2).heirOf(owner), address(0), "owners are independent");

        address heir2 = makeAddr("heir2");
        vm.prank(keeper);
        delegated(owner2).registerHeir(owner2, heir2);
        assertEq(delegated(owner2).heirOf(owner2), heir2);
        assertEq(delegated(owner).heirOf(owner2), address(0));
    }

    // --- Arbitrum same-chain estate gate (real RetenixPolicy) ---

    function test_arbGateRejectsEnrolled() public {
        enrollEstateFor(OWNER_PK, 120);
        vm.signAndAttachDelegation(address(claimArb), OWNER_PK);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.NotClaimable.selector);
        delegated(owner).registerHeir(owner, heir);
    }

    function test_arbGateRejectsCountdownPreWindow() public {
        enrollEstateFor(OWNER_PK, 120);
        vm.warp(block.timestamp + 121);
        policy.fireDeadline(owner);
        vm.signAndAttachDelegation(address(claimArb), OWNER_PK);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.NotClaimable.selector);
        delegated(owner).registerHeir(owner, heir);
    }

    function test_arbGateAcceptsClaimable() public {
        driveToClaimable(OWNER_PK);
        assertEq(uint8(policy.estateStatus(owner)), uint8(RetenixPolicy.EstateStatus.Claimable));
        vm.signAndAttachDelegation(address(claimArb), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);
        assertEq(delegated(owner).heirOf(owner), heir);
    }

    /// markClaimed runs FIRST in the claim sequence (the single commit point),
    /// so the gate must also accept Claimed — reachable only via the keeper's
    /// markClaimed, which itself required Claimable.
    function test_arbGateAcceptsClaimedPostMarkClaimed() public {
        driveToClaimable(OWNER2_PK);
        vm.prank(keeper);
        policy.markClaimed(owner2, heir);
        assertEq(uint8(policy.estateStatus(owner2)), uint8(RetenixPolicy.EstateStatus.Claimed));
        vm.signAndAttachDelegation(address(claimArb), OWNER2_PK);
        vm.prank(keeper);
        delegated(owner2).registerHeir(owner2, heir);
        assertEq(delegated(owner2).heirOf(owner2), heir);
    }

    function test_arbGateRejectsCancelled() public {
        enrollEstateFor(OWNER_PK, 120);
        vm.warp(block.timestamp + 121);
        policy.fireDeadline(owner);
        vm.prank(owner);
        policy.cancelClaim();
        vm.signAndAttachDelegation(address(claimArb), OWNER_PK);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.NotClaimable.selector);
        delegated(owner).registerHeir(owner, heir);
    }

    // --- claim mechanics ---

    function test_claimRequiresRegisteredHeir() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.HeirNotSet.selector);
        delegated(owner).claim(owner, new address[](0));
    }

    function test_claimMovesFullBalancesAndNative() public {
        MockERC20 tokenA = new MockERC20();
        NoReturnERC20 tokenB = new NoReturnERC20();
        tokenA.mint(owner, 1_500e6);
        tokenB.mint(owner, 42e18);
        vm.deal(owner, 3 ether);

        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        vm.expectEmit(true, true, true, true);
        emit RetenixClaim.AssetClaimed(owner, heir, address(tokenA), 1_500e6);
        vm.expectEmit(true, true, true, true);
        emit RetenixClaim.AssetClaimed(owner, heir, address(tokenB), 42e18);
        vm.expectEmit(true, true, true, true);
        emit RetenixClaim.AssetClaimed(owner, heir, address(0), 3 ether);
        vm.prank(keeper);
        delegated(owner).claim(owner, tokens);

        assertEq(tokenA.balanceOf(owner), 0);
        assertEq(tokenA.balanceOf(heir), 1_500e6);
        assertEq(tokenB.balanceOf(owner), 0);
        assertEq(tokenB.balanceOf(heir), 42e18);
        assertEq(owner.balance, 0, "native swept to exactly zero");
        assertEq(heir.balance, 3 ether);
    }

    function test_claimSkipsZeroBalancesAndIsRerunnable() public {
        MockERC20 tokenA = new MockERC20();
        tokenA.mint(owner, 100e6);
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        vm.prank(keeper);
        delegated(owner).claim(owner, tokens);
        assertEq(tokenA.balanceOf(heir), 100e6);

        // second run: zero balance, zero native — clean no-op (crash-resume path)
        vm.prank(keeper);
        delegated(owner).claim(owner, tokens);
        assertEq(tokenA.balanceOf(heir), 100e6);
    }

    function test_claimRevertsOnFalseReturningToken() public {
        FalseReturnERC20 bad = new FalseReturnERC20();
        bad.mint(owner, 5e18);
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);

        address[] memory tokens = new address[](1);
        tokens[0] = address(bad);
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.TransferFailed.selector);
        delegated(owner).claim(owner, tokens);
    }

    function test_claimRevertsWhenHeirCannotReceiveNative() public {
        RevertingReceiver blocked = new RevertingReceiver();
        vm.deal(owner, 1 ether);
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, address(blocked));
        vm.prank(keeper);
        vm.expectRevert(RetenixClaim.NativeSweepFailed.selector);
        delegated(owner).claim(owner, new address[](0));
    }

    /// While delegated, incoming plain native transfers execute the delegate's
    /// code — the payable receive keeps them from bouncing.
    function test_delegatedOwnerStillReceivesNative() public {
        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.deal(address(this), 1 ether);
        (bool ok,) = owner.call{value: 0.5 ether}("");
        assertTrue(ok, "delegated owner accepts native");
        assertEq(owner.balance, 0.5 ether);
    }

    // --- fuzz ---

    function testFuzz_claimMovesArbitraryBalances(uint128 balA, uint128 balB, uint96 nat) public {
        MockERC20 tokenA = new MockERC20();
        MockERC20 tokenB = new MockERC20();
        tokenA.mint(owner, balA);
        tokenB.mint(owner, balB);
        vm.deal(owner, nat);

        vm.signAndAttachDelegation(address(claimImpl), OWNER_PK);
        vm.prank(keeper);
        delegated(owner).registerHeir(owner, heir);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(keeper);
        delegated(owner).claim(owner, tokens);

        assertEq(tokenA.balanceOf(heir), balA);
        assertEq(tokenB.balanceOf(heir), balB);
        assertEq(heir.balance, nat);
        assertEq(owner.balance, 0);
        assertEq(tokenA.balanceOf(owner), 0);
        assertEq(tokenB.balanceOf(owner), 0);
    }
}
