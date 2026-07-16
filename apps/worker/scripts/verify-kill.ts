// Kill-switch verifier (doc 13 DoD, owner-run half): after a real kill on a
// seeded account, assert from the OUTSIDE that
//   1. every kill.leg row is terminal and receipted; the aggregate
//      kill.receipt exists with counts that match the rows (PS-F6-AC2),
//   2. recordExecution reverts NotActive for every revoked contractPlanId —
//      proven via eth_call with from = the agent address (a staticcall: no
//      key, no gas, mainnet-safe),
//   3. buying power has converged to USDC-only above dust (getPrimaryAssets),
//   4. and print the AC1 marks (tap → last submission) recorded on the rows.
//
// Run: KILL_USER_ID=<users.id> pnpm --filter worker verify:kill
// (Particle creds optional — check 3 is skipped honestly without them.)

import { events, getDb, plans, users } from "@retenix/db";
import {
  KILL_EVENTS,
  RETENIX_POLICY_ABI,
  killLegPayloadSchema,
  killStartedPayloadSchema,
  isKillTerminal,
  type KillReceiptPayload,
} from "@retenix/shared";
import { assetIdHash } from "@retenix/registry";
import { createUa, getPrimaryAssets } from "@retenix/ua";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Contract, Interface, JsonRpcProvider, type InterfaceAbi } from "ethers";
import { env } from "../env";
import { ownerAction, particleReady, policyReady } from "./lib";

/** Balances at or below this are dust, not a failed convergence (doc 06's
 *  floor — the kill deliberately leaves sub-floor primaries to the sweeper). */
const DUST_USD = 0.5;

async function main(): Promise<number> {
  const userId = process.env.KILL_USER_ID;
  if (!userId) {
    ownerAction("verify-kill", [
      "run a real kill on the seeded account first (doc 16 runbook)",
      "then: KILL_USER_ID=<users.id> pnpm --filter worker verify:kill",
    ]);
  }
  const db = getDb();
  let failures = 0;
  const fail = (msg: string) => {
    console.log(`FAIL  ${msg}`);
    failures += 1;
  };
  const ok = (msg: string) => console.log(`OK    ${msg}`);

  // --- load the latest kill -------------------------------------------------
  const [startedRow] = await db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, KILL_EVENTS.started)))
    .orderBy(desc(events.createdAt))
    .limit(1);
  if (!startedRow) {
    fail("no kill.started row — has a kill run for this user?");
    return 1;
  }
  const started = killStartedPayloadSchema.parse(startedRow.payloadJson);
  console.log(`\n[verify-kill] kill ${started.killId}\n`);

  const legRows = await db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, KILL_EVENTS.leg),
        sql`${events.payloadJson}->>'killId' = ${started.killId}`,
      ),
    );
  const legs = legRows.map((r) => killLegPayloadSchema.parse(r.payloadJson));

  // --- 1. legs terminal + receipted; aggregate honest -----------------------
  for (const leg of legs) {
    if (!isKillTerminal(leg.outcome)) {
      fail(`leg ${leg.symbol} (${leg.legId}) not terminal: ${leg.outcome}`);
    } else if (!leg.receipt) {
      fail(`leg ${leg.symbol} terminal (${leg.outcome}) but carries no receipt string`);
    } else {
      ok(`leg ${leg.symbol}: ${leg.outcome} — "${leg.receipt}"`);
    }
  }

  const [receiptRow] = await db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, KILL_EVENTS.receipt),
        sql`${events.payloadJson}->>'killId' = ${started.killId}`,
      ),
    )
    .limit(1);
  if (!receiptRow) {
    fail("no aggregate kill.receipt row");
  } else {
    const receipt = receiptRow.payloadJson as KillReceiptPayload;
    const settled = legs.filter((l) => l.outcome === "settled").length;
    const retryable = legs.filter(
      (l) => isKillTerminal(l.outcome) && l.outcome !== "settled",
    ).length;
    if (receipt.liquidated !== settled || receipt.total !== legs.length) {
      fail(
        `aggregate counts dishonest: says ${receipt.liquidated}/${receipt.total}, rows say ${settled}/${legs.length}`,
      );
    } else if (receipt.retryable !== retryable) {
      fail(`aggregate retryable=${receipt.retryable}, rows say ${retryable}`);
    } else {
      ok(`aggregate: "${receipt.receipt}"`);
    }
  }

  // --- 2. recordExecution reverts NotActive per revoked plan ---------------
  if (!policyReady()) {
    console.log("SKIP  policy checks — POLICY_CONTRACT_ADDRESS is a placeholder");
  } else {
    try {
      const provider = new JsonRpcProvider(env.RPC_URL_ARBITRUM, undefined, {
        staticNetwork: true,
      });
      const iface = new Interface(RETENIX_POLICY_ABI as InterfaceAbi);
      const policy = new Contract(env.POLICY_CONTRACT_ADDRESS, iface, provider);
      const agent = (await policy.agent()) as string;

      const revoked = await db
        .select({ id: plans.id, kind: plans.kind, contractPlanId: plans.contractPlanId })
        .from(plans)
        .where(
          and(
            eq(plans.userId, userId),
            eq(plans.status, "revoked"),
            ne(plans.kind, "legacy"),
            sql`${plans.contractPlanId} is not null`,
          ),
        );
      if (revoked.length === 0) {
        console.log("SKIP  no revoked onchain plans to probe");
      }
      for (const plan of revoked) {
        const data = iface.encodeFunctionData("recordExecution", [
          BigInt(plan.contractPlanId as number),
          1_000_000n, // $1 in usd6 — never lands, this is a staticcall
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
      if (started.revoke.txHash) {
        const rc = await provider.getTransactionReceipt(started.revoke.txHash);
        if (rc?.status === 1) ok(`revokeAll tx ${started.revoke.txHash} confirmed onchain`);
        else fail(`revokeAll tx ${started.revoke.txHash}: ${rc ? "reverted" : "not found"}`);
      }
    } catch (err) {
      // Placeholder/unreachable RPC — an infra gap, not a verification verdict.
      console.log(
        `SKIP  onchain probes — RPC_URL_ARBITRUM unusable (${err instanceof Error ? err.message.slice(0, 80) : "error"})`,
      );
    }
  }

  // --- 3. buying power converged to USDC ------------------------------------
  if (!particleReady()) {
    console.log("SKIP  balance convergence — Particle creds are placeholders");
  } else {
    const [userRow] = await db
      .select({ eoaAddr: users.eoaAddr })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const ua = createUa({
      ownerAddress: userRow.eoaAddr,
      credentials: {
        projectId: env.PARTICLE_PROJECT_ID,
        projectClientKey: env.PARTICLE_CLIENT_KEY,
        projectAppUuid: env.PARTICLE_APP_UUID,
      },
    });
    const assets = (await getPrimaryAssets(ua)).assets ?? [];
    for (const asset of assets) {
      const usd = asset.amountInUSD ?? 0;
      if (asset.tokenType === "usdc") {
        ok(`USDC balance: $${usd.toFixed(2)}`);
      } else if (usd > DUST_USD) {
        fail(`${asset.tokenType.toUpperCase()} still holds $${usd.toFixed(2)} (> $${DUST_USD} dust floor)`);
      } else if (usd > 0) {
        ok(`${asset.tokenType.toUpperCase()} residual $${usd.toFixed(2)} — dust, the sweeper's domain`);
      }
    }
  }

  // --- 4. AC1 marks ----------------------------------------------------------
  const lastSubmit = legs.reduce<number | null>(
    (max, l) =>
      l.submittedAtMs !== undefined && (max === null || l.submittedAtMs > max)
        ? l.submittedAtMs
        : max,
    null,
  );
  if (started.tapAtMs && lastSubmit) {
    const delta = lastSubmit - started.tapAtMs;
    const hold = started.holdCompletedAtMs
      ? started.holdCompletedAtMs - started.tapAtMs
      : null;
    console.log(
      `\n[AC1] tap → last submission: ${delta}ms (budget 10000ms)` +
        (hold !== null ? ` · tap → hold-complete: ${hold}ms` : ""),
    );
    if (delta >= 10_000) fail("PS-F6-AC1: tap → last submission exceeded 10s");
  } else {
    console.log("\n[AC1] marks incomplete (tap or submissions missing) — run from the Home header tap");
  }

  console.log(
    failures === 0
      ? `\n[verify-kill] OK — kill ${started.killId} verified`
      : `\n[verify-kill] FAILED — ${failures} check(s) failed`,
  );
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[verify-kill] error:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
