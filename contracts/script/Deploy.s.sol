// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RetenixPolicy} from "../src/RetenixPolicy.sol";

/// Deploys RetenixPolicy (doc 07). Constructor args come from env:
///   DEPLOYER_PRIVATE_KEY            — canonical (doc 00); dev deploys only
///   AGENT_ADDRESS                   — PROPOSED; defaults to the deployer.
///                                     agent is IMMUTABLE: the Arbitrum One
///                                     deploy bakes it in (KMS address once
///                                     module 08 provisions it — else redeploy)
///   KEEPER_ADDRESS / RELAYER_ADDRESS — PROPOSED; default to the deployer;
///                                     rotatable later via setKeeper/setRelayer
///   DEMO_CHALLENGE_WINDOW_SECS      — canonical (doc 00 worker table); default 60.
///                                     Prod value TBD (tech spec §9).
///
/// After Chainlink registration, call setAutomationForwarder(<forwarder>) —
/// see script/RegisterUpkeep.md.
contract Deploy is Script {
    function run() external returns (RetenixPolicy policy) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address agent = vm.envOr("AGENT_ADDRESS", deployer);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);
        address relayer = vm.envOr("RELAYER_ADDRESS", deployer);
        uint64 challengeWindowSecs = uint64(vm.envOr("DEMO_CHALLENGE_WINDOW_SECS", uint256(60)));

        vm.startBroadcast(pk);
        policy = new RetenixPolicy(agent, keeper, relayer, challengeWindowSecs);
        vm.stopBroadcast();

        console.log("RetenixPolicy deployed:", address(policy));
        console.log("  chain id:            ", block.chainid);
        console.log("  admin (deployer):    ", deployer);
        console.log("  agent (immutable):   ", agent);
        console.log("  keeper:              ", keeper);
        console.log("  relayer:             ", relayer);
        console.log("  challengeWindowSecs: ", challengeWindowSecs);
        console.log("Record the address in POLICY_CONTRACT_ADDRESS, docs/deployments.md,");
        console.log("and packages/shared/src/contracts.ts. Then register the upkeep");
        console.log("(script/RegisterUpkeep.md) and setAutomationForwarder.");
    }
}
