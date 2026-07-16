// Shared plumbing for the doc-08 rehearsal/smoke CLIs. All of these are
// ENV-GATED, OWNER-RUN mainnet tools (G7: no UA testnet; $50 wallet /
// $5-day budget): with placeholder credentials they print the owner-action
// and exit 0 — the modules 03/05/07 pattern — so CI and fresh clones stay
// green while the runbook stays executable.

import { Wallet } from "ethers";
import { getDb, plans, users, type Db } from "@retenix/db";
import { REGISTRY, assetListHash } from "@retenix/registry";
import {
  nextCadenceRun,
  toUsd6,
  createPlanDigest,
  signPolicyDigest,
  type BrokerPlanParams,
  type Cadence,
} from "@retenix/shared";

import { env } from "../env";
import { getAgentSigner, type AgentSigner } from "../src/kms";
import { PolicyClient } from "../src/policy";

export function ownerAction(script: string, lines: string[]): never {
  console.log(`\n[${script}] OWNER ACTION REQUIRED — nothing was executed:`);
  for (const line of lines) console.log(`  • ${line}`);
  console.log("");
  process.exit(0);
}

export const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000";

export function particleReady(): boolean {
  return (
    env.PARTICLE_PROJECT_ID !== PLACEHOLDER_UUID &&
    !env.PARTICLE_CLIENT_KEY.includes("PLACEHOLDER") &&
    env.PARTICLE_APP_UUID !== PLACEHOLDER_UUID
  );
}

export function policyReady(): boolean {
  return !/^0x0{40}$/.test(env.POLICY_CONTRACT_ADDRESS);
}

export interface Rig {
  db: Db;
  agent: AgentSigner;
  policy: PolicyClient;
}

/** Resolve the signer + policy client, asserting the contract agent. */
export async function buildRig(script: string): Promise<Rig> {
  let agent: AgentSigner;
  try {
    agent = await getAgentSigner();
  } catch (err) {
    ownerAction(script, [
      "no usable agent signer — set AGENT_EOA_PRIVATE_KEY (dev) or real AWS KMS credentials (AWS_REGION + KMS_AGENT_KEY_ID + IAM access)",
      `resolver said: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const policy = new PolicyClient({
    rpcUrl: env.RPC_URL_ARBITRUM,
    address: env.POLICY_CONTRACT_ADDRESS,
    signer: agent.ethSigner,
  });
  const onchainAgent = await policy.contractAgent();
  if (onchainAgent.toLowerCase() !== agent.address.toLowerCase()) {
    console.error(
      `[${script}] FATAL agent mismatch: contract ${env.POLICY_CONTRACT_ADDRESS} expects ${onchainAgent}, signer is ${agent.address}.\n` +
        `Redeploy (~$0.30): AGENT_ADDRESS=${agent.address} forge script contracts/script/Deploy.s.sol --rpc-url $ARBITRUM_ONE_RPC_URL --broadcast --verify\n` +
        "then update POLICY_CONTRACT_ADDRESS, packages/shared/src/contracts.ts, docs/deployments.md.",
    );
    process.exit(1);
  }
  return { db: getDb(), agent, policy };
}

export interface StagingPlanSpec {
  cadence: Cadence;
  amountUsd: number;
  basket: { assetId: string; pct: number }[];
  capPerExecUsd: number;
  capPerPeriodUsd: number;
  periodSecs: number;
}

/** $2/day 100% SOL — the doc-08 integration staging plan. */
export const DAILY_SOL: StagingPlanSpec = {
  cadence: "daily",
  amountUsd: 2,
  basket: [{ assetId: "sol", pct: 100 }],
  capPerExecUsd: 10,
  capPerPeriodUsd: 20,
  periodSecs: 86_400,
};

/** $25/week 60-30-10 — the DoD shape (module 16 demo rehearsal). */
export const WEEKLY_BASKET: StagingPlanSpec = {
  cadence: "weekly",
  amountUsd: 25,
  basket: [
    { assetId: "spyx", pct: 60 },
    { assetId: "tslax", pct: 30 },
    { assetId: "sol", pct: 10 },
  ],
  capPerExecUsd: 50,
  capPerPeriodUsd: 50,
  periodSecs: 604_800,
};

/**
 * Create the plan ONCHAIN (ephemeral or provided owner key; relayed
 * createPlan submitted and paid by the agent EOA) and mirror it into the
 * plans table with a valid params_json. Returns everything a rehearsal
 * needs to execute and verify.
 */
export async function createStagingPlan(
  rig: Rig,
  spec: StagingPlanSpec,
): Promise<{ planId: string; contractPlanId: number; userId: string; owner: string }> {
  const owner = process.env.STAGING_OWNER_PRIVATE_KEY
    ? new Wallet(process.env.STAGING_OWNER_PRIVATE_KEY)
    : Wallet.createRandom();
  for (const leg of spec.basket) {
    if (!REGISTRY.some((a) => a.id === leg.assetId)) {
      throw new Error(`staging plan asset ${leg.assetId} is not in the registry`);
    }
  }
  const ids = [...spec.basket.map((b) => b.assetId)].sort(); // PRE-SORTED (doc 07)
  const listHash = assetListHash(ids);
  const network = await rig.policy.provider.getNetwork();

  const contract = new (await import("ethers")).Contract(
    env.POLICY_CONTRACT_ADDRESS,
    (await import("@retenix/shared")).RETENIX_POLICY_ABI,
    rig.agent.ethSigner.connect(rig.policy.provider),
  );
  const nonce = (await contract.authNonces(owner.address)) as bigint;
  const digest = createPlanDigest(
    { chainId: network.chainId, contract: env.POLICY_CONTRACT_ADDRESS },
    {
      agent: rig.agent.address,
      capPerExec: toUsd6(spec.capPerExecUsd),
      capPerPeriod: toUsd6(spec.capPerPeriodUsd),
      periodSecs: spec.periodSecs,
      assetListHash: listHash,
      nonce,
    },
  );
  const sig = await signPolicyDigest(owner, digest);
  console.log(`[staging] createPlan → owner ${owner.address} (ephemeral), nonce ${nonce}`);
  const tx = await contract.createPlan(
    owner.address,
    toUsd6(spec.capPerExecUsd),
    toUsd6(spec.capPerPeriodUsd),
    spec.periodSecs,
    listHash,
    ids,
    nonce,
    sig,
  );
  const receipt = await tx.wait(1);
  const created = receipt.logs
    .map((log: { topics: readonly string[]; data: string }) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((p: { name: string } | null) => p?.name === "PlanCreated");
  if (!created) throw new Error("PlanCreated event not found in the createPlan receipt");
  const contractPlanId = Number(created.args[0]);
  console.log(
    `[staging] plan #${contractPlanId} created onchain — https://arbiscan.io/tx/${receipt.hash}`,
  );

  const activatedAt = new Date();
  const params: BrokerPlanParams = {
    cadence: spec.cadence,
    amountUsd: spec.amountUsd,
    basket: spec.basket,
    capPerExecUsd: spec.capPerExecUsd,
    capPerPeriodUsd: spec.capPerPeriodUsd,
    periodSecs: spec.periodSecs,
    nextRunAt: nextCadenceRun(spec.cadence, activatedAt, activatedAt).toISOString(),
    topUpOptIn: false,
  };
  const [userRow] = await rig.db
    .insert(users)
    .values({
      emailHash: `staging-${Date.now()}-${contractPlanId}`,
      eoaAddr: owner.address,
      uaEvmAddr: owner.address,
      uaSolAddr: "",
      region: "NG",
    })
    .returning({ id: users.id });
  const [planRow] = await rig.db
    .insert(plans)
    .values({
      userId: userRow.id,
      kind: "broker",
      status: "active",
      contractPlanId,
      activatedAt,
      paramsJson: params,
    })
    .returning({ id: plans.id });
  console.log(`[staging] plans row ${planRow.id} (user ${userRow.id})`);
  return { planId: planRow.id, contractPlanId, userId: userRow.id, owner: owner.address };
}
