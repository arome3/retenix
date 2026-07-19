// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RetenixHedge} from "../src/RetenixHedge.sol";

/// Deploys RetenixHedge (doc 19, F12) — the COMPANION to RetenixPolicy, not a
/// replacement for it (decision D-H1: RetenixPolicy is frozen on Arbitrum One
/// and RetenixClaim holds its address immutable).
///
/// Constructor args come from env:
///   DEPLOYER_PRIVATE_KEY          — canonical (doc 00); dev deploys only
///   AGENT_ADDRESS                 — defaults to the deployer. IMMUTABLE: the
///                                   One deploy bakes it in (use the KMS
///                                   address once module 08 provisions it —
///                                   else redeploy, same as RetenixPolicy)
///   HEDGE_ATTESTATION_MAX_AGE_SECS — default 900 (15 min). The freshness
///                                   window for the per-open holding-value
///                                   attestation; a stale attestation is a
///                                   replayed high-water mark.
contract DeployHedge is Script {
    function run() external returns (RetenixHedge hedge) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address agent = vm.envOr("AGENT_ADDRESS", deployer);
        uint64 attestationMaxAgeSecs =
            uint64(vm.envOr("HEDGE_ATTESTATION_MAX_AGE_SECS", uint256(900)));

        vm.startBroadcast(pk);
        hedge = new RetenixHedge(agent, attestationMaxAgeSecs);
        vm.stopBroadcast();

        console.log("RetenixHedge deployed:   ", address(hedge));
        console.log("  chain id:              ", block.chainid);
        console.log("  admin (deployer):      ", deployer);
        console.log("  agent (immutable):     ", agent);
        console.log("  attestationMaxAgeSecs: ", attestationMaxAgeSecs);
        console.log("Record in HEDGE_CONTRACT_ADDRESS, docs/deployments.md, and");
        console.log("packages/shared/src/contracts.ts. NOTE: this contract has its OWN");
        console.log("authNonces space - relay helpers must read nonces from THIS address.");
    }
}
