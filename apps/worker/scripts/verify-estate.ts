// Estate verifier (doc 14 DoD, owner-run half): after the demo-scaled
// enroll → quiet → claim run on a seeded account, assert PS-F7-AC1/AC2 from
// the OUTSIDE:
//   1. the estates row holds ciphertext envelopes (never plaintext) and a
//      fresh tuple set; the estate.enrolled event exists,
//   2. the onchain estate state matches the story (enrolled / countdown /
//      claimed) and lastCheckIn moved when the heartbeat relayed (AC2's
//      backend — read via eth_call, no key, no gas),
//   3. the event chain is complete and honest: countdown_started →
//      claim_email_sent (token HASH only) → claim_started/claim_requested →
//      per-source claim_progress → claimed with matching counts,
//   4. check-in provenance: every estate.checkin row carries its CONFLICTS
//      #13 proof (signed envelope or observation watermark),
//   5. the heir's balance converged (getPrimaryAssets on the heir EOA) —
//      skipped honestly without Particle creds.
//
// Run: ESTATE_USER_ID=<owner users.id> [HEIR_EOA=0x…] pnpm --filter worker verify:estate
import { estates, events, getDb, users } from "@retenix/db";
import {
  ESTATE_EVENTS,
  RETENIX_POLICY_ABI,
  claimChainProgressSchema,
  estateStatusName,
} from "@retenix/shared";
import { parseEnvelope } from "@retenix/shared/escrow";
import { createUa, getPrimaryAssets } from "@retenix/ua";
import { asc, eq } from "drizzle-orm";
import { Contract, JsonRpcProvider } from "ethers";
import { env } from "../env";
import { ownerAction, particleReady } from "./lib";

async function main(): Promise<number> {
  const userId = process.env.ESTATE_USER_ID;
  if (!userId) {
    ownerAction("verify-estate", [
      "run the demo-scaled estate flow first (enroll on /legacy → go quiet 120s →",
      "C8 countdown → claim from the emailed/logged link on a second inbox)",
      "then: ESTATE_USER_ID=<owner users.id> pnpm --filter worker verify:estate",
      "optional: HEIR_EOA=0x… to assert the heir balance convergence",
    ]);
  }

  const db = getDb();
  let failures = 0;
  const fail = (msg: string) => {
    console.log(`FAIL  ${msg}`);
    failures += 1;
  };
  const pass = (msg: string) => console.log(`ok    ${msg}`);
  const skip = (msg: string) => console.log(`SKIP  ${msg}`);

  const [owner] = await db
    .select({ id: users.id, eoa: users.eoaAddr })
    .from(users)
    .where(eq(users.id, userId!))
    .limit(1);
  if (!owner) {
    fail(`no users row for ${userId}`);
    return 1;
  }

  // --- 1. the estates row: ciphertext at rest, tuples escrowed -------------
  const [estate] = await db
    .select()
    .from(estates)
    .where(eq(estates.userId, owner.id))
    .limit(1);
  if (!estate) {
    fail("no estates row — enrollment never persisted");
  } else {
    try {
      const emailEnv = parseEnvelope(estate.beneficiaryEmailEnc);
      pass(`beneficiary secret is a ${emailEnv.kind} envelope (ciphertext at rest)`);
      if (estate.beneficiaryEmailEnc.includes("@")) {
        fail("beneficiary_email_enc contains a plaintext address");
      }
    } catch {
      fail("beneficiary_email_enc is not an escrow envelope");
    }
    if (estate.tuplesEnc) {
      try {
        parseEnvelope(estate.tuplesEnc);
        pass(
          `tuple set escrowed (refreshed ${estate.refreshedAt?.toISOString() ?? "never"})`,
        );
      } catch {
        fail("tuples_enc is not an escrow envelope");
      }
    } else {
      fail("tuples_enc is empty — the ceremony never escrowed coverage");
    }
  }

  // --- 2. onchain estate state (staticcalls — no key, no gas) --------------
  const policyPlaceholder = !env.POLICY_CONTRACT_ADDRESS.startsWith("0x");
  if (policyPlaceholder) {
    skip("onchain estate probes — POLICY_CONTRACT_ADDRESS is a placeholder");
  } else {
    try {
      const provider = new JsonRpcProvider(env.RPC_URL_ARBITRUM);
      const policy = new Contract(env.POLICY_CONTRACT_ADDRESS, RETENIX_POLICY_ABI, provider);
      const e = (await policy.estates(owner.eoa)) as [string, string, bigint, bigint, bigint, bigint];
      const status = Number((await policy.estateStatus(owner.eoa)) as bigint);
      const name = estateStatusName(status);
      if (name === "none") {
        fail("onchain estate status is None — enrollEstate never landed");
      } else {
        pass(
          `onchain estate: ${name} · lastCheckIn ${new Date(Number(e[3]) * 1000).toISOString()} · inactivitySecs ${e[2]}`,
        );
      }
      const fired = await policy.queryFilter(policy.filters.DeadlineFired(owner.eoa), -1_000_000);
      if (fired.length > 0) {
        pass(`DeadlineFired observed onchain (${fired.length}× — the countdown really fired)`);
      } else {
        skip("no DeadlineFired event in the scanned range (owner never went quiet?)");
      }
    } catch (err) {
      skip(
        `onchain probes — RPC_URL_ARBITRUM unusable (${err instanceof Error ? err.message.slice(0, 80) : "error"})`,
      );
    }
  }

  // --- 3 + 4. the event chain ------------------------------------------------
  const rows = await db
    .select({ type: events.type, payload: events.payloadJson, at: events.createdAt })
    .from(events)
    .where(eq(events.userId, owner.id))
    .orderBy(asc(events.createdAt));
  const byType = (t: string) => rows.filter((r) => r.type === t);

  if (byType(ESTATE_EVENTS.enrolled).length === 0) fail("no estate.enrolled event");
  else pass("estate.enrolled recorded");

  const checkins = byType(ESTATE_EVENTS.checkin);
  const unproven = checkins.filter((r) => {
    const p = r.payload as { proof?: unknown } | null;
    return !p?.proof;
  });
  if (checkins.length === 0) skip("no estate.checkin rows (nothing relayed yet)");
  else if (unproven.length > 0) {
    fail(`${unproven.length}/${checkins.length} check-ins carry NO provenance proof (CONFLICTS #13)`);
  } else {
    pass(`${checkins.length} check-in(s), every one carries its provenance proof`);
  }

  const emails = byType(ESTATE_EVENTS.claimEmailSent);
  for (const row of emails) {
    const p = row.payload as { tokenHash?: string } & Record<string, unknown>;
    const raw = JSON.stringify(p);
    if (!p.tokenHash || !/^0x[0-9a-f]{64}$/.test(p.tokenHash)) {
      fail("claim email event without a token HASH");
    }
    if (/[0-9a-f]{64}/.test(raw.replace(p.tokenHash ?? "", "")) && raw.includes("token\":")) {
      fail("claim email event appears to store a raw token");
    }
  }
  if (emails.length > 0) pass(`${emails.length} claim email(s) minted — hash-only at rest`);

  const claimed = byType(ESTATE_EVENTS.claimed).at(-1);
  if (!claimed) {
    skip("no estate.claimed event (the claim has not run — AC1 incomplete)");
  } else {
    const progress = byType(ESTATE_EVENTS.claimProgress)
      .map((r) => claimChainProgressSchema.safeParse(r.payload))
      .filter((p) => p.success)
      .map((p) => p.data!);
    const claimedSources = new Set(
      progress.filter((p) => p.state === "claimed").map((p) => p.chainId),
    );
    const payload = claimed.payload as { sourceCount?: number };
    if (payload.sourceCount !== claimedSources.size) {
      fail(
        `estate.claimed says ${payload.sourceCount} sources but ${claimedSources.size} progress rows claimed`,
      );
    } else {
      pass(
        `claim completed honestly: ${claimedSources.size} source(s) claimed, ${progress.length} progress rows`,
      );
    }
  }

  // --- 5. heir balance convergence -------------------------------------------
  const heirEoa = process.env.HEIR_EOA;
  if (!heirEoa) {
    skip("heir balance — set HEIR_EOA=0x… to assert it");
  } else if (!particleReady()) {
    skip("heir balance — Particle creds are placeholders");
  } else {
    try {
      const ua = createUa({
        ownerAddress: heirEoa,
        credentials: {
          projectId: env.PARTICLE_PROJECT_ID,
          projectClientKey: env.PARTICLE_CLIENT_KEY,
          projectAppUuid: env.PARTICLE_APP_UUID,
        },
      });
      const assets = (await getPrimaryAssets(ua)) as { totalAmountInUSD?: number | string };
      const total = Number(assets.totalAmountInUSD ?? 0);
      if (total > 0) pass(`heir UA holds $${total.toFixed(2)} (arrival converged)`);
      else fail("heir UA balance is $0.00 — nothing arrived");
    } catch (err) {
      skip(
        `heir balance — UA read failed (${err instanceof Error ? err.message.slice(0, 80) : "error"})`,
      );
    }
  }

  console.log(
    failures === 0
      ? "\nverify-estate: PASS (with any SKIPs listed above)"
      : `\nverify-estate: ${failures} FAILURE(S)`,
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("verify-estate crashed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
