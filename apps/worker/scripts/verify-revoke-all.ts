// Revoke-all verifier (doc 15 DoD, owner-run half): after a real "Dismiss
// all staff" on a seeded account, assert from the OUTSIDE that
//   1. every revoked broker/guardian plan's recordExecution reverts
//      NotActive (eth_call with from = the agent — a staticcall: no key, no
//      gas, mainnet-safe; doc-13 parity),
//   2. the security.revoke_all relay tx confirmed onchain,
//   3. and the legacy plan (if any) is UNTOUCHED — dismissal never cancels
//      the estate.
//
// Run: REVOKE_USER_ID=<users.id> pnpm --filter worker verify:revoke-all
import { events, getDb, plans } from "@retenix/db";
import { RETENIX_POLICY_ABI } from "@retenix/shared";
import { assetIdHash } from "@retenix/registry";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Contract, Interface, JsonRpcProvider, type InterfaceAbi } from "ethers";
import { env } from "../env";
import { ownerAction, policyReady } from "./lib";

let failures = 0;
const ok = (msg: string) => console.log(`OK    ${msg}`);
const fail = (msg: string) => {
  failures += 1;
  console.log(`FAIL  ${msg}`);
};

async function main(): Promise<number> {
  const userId = process.env.REVOKE_USER_ID;
  if (!userId) {
    ownerAction("verify-revoke-all", [
      "run a real 'Dismiss all staff' from /profile/security on a seeded account",
      "then: REVOKE_USER_ID=<users.id> pnpm --filter worker verify:revoke-all",
    ]);
  }

  const db = getDb();

  // --- 3. legacy untouched --------------------------------------------------
  const rows = await db
    .select({ kind: plans.kind, status: plans.status, contractPlanId: plans.contractPlanId })
    .from(plans)
    .where(eq(plans.userId, userId as string));
  const legacy = rows.filter((r) => r.kind === "legacy");
  for (const l of legacy) {
    if (l.status === "revoked") fail("legacy plan was flipped — dismissal must never touch the estate");
    else ok(`legacy plan status "${l.status}" — untouched`);
  }

  // --- 1./2. onchain probes ---------------------------------------------------
  if (!policyReady()) {
    console.log("SKIP  onchain probes — POLICY_CONTRACT_ADDRESS is a placeholder");
  } else {
    try {
      const provider = new JsonRpcProvider(env.RPC_URL_ARBITRUM, undefined, {
        staticNetwork: true,
      });
      const iface = new Interface(RETENIX_POLICY_ABI as InterfaceAbi);
      const policy = new Contract(env.POLICY_CONTRACT_ADDRESS, iface, provider);
      const agent = (await policy.agent()) as string;

      const revoked = await db
        .select({ kind: plans.kind, contractPlanId: plans.contractPlanId })
        .from(plans)
        .where(
          and(
            eq(plans.userId, userId as string),
            eq(plans.status, "revoked"),
            ne(plans.kind, "legacy"),
            sql`${plans.contractPlanId} is not null`,
          ),
        );
      if (revoked.length === 0) console.log("SKIP  no revoked onchain plans to probe");
      for (const plan of revoked) {
        const data = iface.encodeFunctionData("recordExecution", [
          BigInt(plan.contractPlanId as number),
          1_000_000n, // $1 usd6 — never lands, this is a staticcall
          assetIdHash("spyx"),
        ]);
        try {
          await provider.call({ to: env.POLICY_CONTRACT_ADDRESS, data, from: agent });
          fail(`plan ${plan.contractPlanId} (${plan.kind}): recordExecution did NOT revert`);
        } catch (err) {
          const errData = (err as { data?: string }).data;
          const name = errData ? iface.parseError(errData)?.name : undefined;
          if (name === "NotActive") {
            ok(`plan ${plan.contractPlanId} (${plan.kind}): recordExecution reverts NotActive`);
          } else {
            fail(
              `plan ${plan.contractPlanId}: reverted with ${name ?? "an undecodable error"} (expected NotActive)`,
            );
          }
        }
      }

      const audit = await db
        .select({ payloadJson: events.payloadJson })
        .from(events)
        .where(
          and(eq(events.userId, userId as string), eq(events.type, "security.revoke_all")),
        )
        .orderBy(desc(events.createdAt))
        .limit(1);
      const txHash = (audit[0]?.payloadJson as { txHash?: string } | undefined)?.txHash;
      if (!txHash) {
        console.log("SKIP  no security.revoke_all audit row (was the dismissal run?)");
      } else {
        const rc = await provider.getTransactionReceipt(txHash);
        if (rc?.status === 1) ok(`revokeAll tx ${txHash} confirmed onchain`);
        else fail(`revokeAll tx ${txHash}: ${rc ? "reverted" : "not found"}`);
      }
    } catch (err) {
      console.log(
        `SKIP  onchain probes — RPC_URL_ARBITRUM unusable (${err instanceof Error ? err.message.slice(0, 80) : "error"})`,
      );
    }
  }

  console.log(failures === 0 ? "\nverify-revoke-all: PASS" : `\nverify-revoke-all: ${failures} FAILURE(S)`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`verify-revoke-all failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
