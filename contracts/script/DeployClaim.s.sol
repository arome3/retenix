// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RetenixClaim} from "../src/RetenixClaim.sol";

/// Deploys RetenixClaim (doc 14) — once per EVM chain (5 deployments:
/// Ethereum 1, BSC 56, Base 8453, X Layer 196, Arbitrum One 42161).
/// Constructor args come from env:
///   DEPLOYER_PRIVATE_KEY — canonical (doc 00)
///   KEEPER_ADDRESS       — PROPOSED; defaults to the deployer. keeper is
///                          IMMUTABLE — if the KMS keeper address differs
///                          later, REDEPLOY on every chain (inactive owners
///                          hold escrowed tuples pointing at THIS delegate;
///                          the old delegate + old keeper key must stay
///                          operational for them — ops invariant, doc 14).
///   POLICY_ADDRESS       — REQUIRED on Arbitrum One (the RetenixPolicy
///                          deployment the delegate re-checks); MUST be unset
///                          or 0 on every other chain (they cannot see
///                          Arbitrum state — keeper is trust-bounded there).
///
/// Record each address as CLAIM_DELEGATE_ADDRESS_<CHAIN> (worker + web env),
/// in docs/deployments.md, and in packages/shared/src/contracts.ts.
contract DeployClaim is Script {
    function run() external returns (RetenixClaim claimDelegate) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);
        address policy = vm.envOr("POLICY_ADDRESS", address(0));

        vm.startBroadcast(pk);
        claimDelegate = new RetenixClaim(keeper, policy);
        vm.stopBroadcast();

        console.log("RetenixClaim deployed:", address(claimDelegate));
        console.log("  chain id:          ", block.chainid);
        console.log("  keeper (immutable):", keeper);
        console.log("  policy (immutable):", policy);
        console.log("Record the address in CLAIM_DELEGATE_ADDRESS_<CHAIN> (worker+web env),");
        console.log("docs/deployments.md, and packages/shared/src/contracts.ts.");
    }
}
