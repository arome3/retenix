// e2e/seed/demo.ts — the demo seed-data contract (doc 16 §Demo seeding).
//
// This file is the SINGLE SOURCE OF TRUTH for the demo's exact numbers. The
// runbook's rule (doc 16): "Dollar figures are seed-data contracts — the
// seeding makes '$212.40', '$23.11', '$4,812' true, so the demo says exactly
// what the spec says." So the canonical route shapes live here ONCE, and both
// the golden-path spec (which mocks the live routes with them) and the staging
// seed (`pnpm seed:demo`) read from the same constants.
//
// Two layers, deliberately:
//   1. DB-derived surfaces (portfolio holdings/snapshots, the gold row, the
//      estate enrolment + the heir-claim landing, the region gate) — really
//      seeded here, so they render for a signed-in demo account.
//   2. Live-onchain surfaces (buying power $212.40 / dust $23.11 come from UA's
//      getPrimaryAssets over REAL balances; estate positions from real chain
//      reads) — the seed cannot fabricate on-chain money. It records the
//      FUNDING TARGET the owner must fund (see the header of each seed fn), and
//      the golden path mocks the route with the canonical constant in CI.
//
// Kept dependency-light on purpose: `e2e/` is not a workspace package, so
// `@retenix/*` does NOT resolve here at runtime (no pnpm symlink). We reuse the
// relative `../support/*` helpers (which only need `pg` + `jose`, root devDeps)
// and inline the two shared primitives we need (claimTokenHash, the estate
// event names) with a pointer to their canonical home in `@retenix/shared`.
//
// Run (staging / local):  pnpm seed:demo   (needs DATABASE_URL)
import { createHash, randomUUID } from "node:crypto";
import { closeDb, dbQuery, type TestUser } from "../support/session";
import {
  BROKER_PARAMS,
  MIXED_BASKET_PARAMS,
  seedEvent,
  seedExecution,
  seedGoldHolding,
  seedPlan,
  seedPlanWithJob,
  seedSnapshot,
} from "../support/feed-seed";

// ---------------------------------------------------------------------------
// Canonical demo constants — the beat assertion strings + route shapes. These
// are byte-for-byte the demo script's sentences (doc 16 §6). Beat copy is a
// REQUIREMENT, not flavour (doc 16 gotcha) — do not "improve" these strings.
// ---------------------------------------------------------------------------

/** Beat 1: buying power "$212.40" sourced from 4 networks (PS-6.1; CONFLICTS
 *  #2 — product spec wins over the blueprint's "3 networks"). The shape the
 *  golden path feeds `account.summary`; the LIVE demo funds these 4 balances. */
export const SUMMARY_212_40 = {
  buyingPowerUsd: 212.4,
  sources: [
    { chainId: 8453, name: "Base", usd: 100, pct: 47.08 },
    { chainId: 42161, name: "Arbitrum", usd: 50, pct: 23.54 },
    { chainId: 1, name: "Ethereum", usd: 40.4, pct: 19.02 },
    { chainId: 101, name: "Solana", usd: 22, pct: 10.36 },
  ],
  assets: [
    {
      symbol: "USDC",
      usd: 150,
      perChain: [
        { chainId: 8453, usd: 100 },
        { chainId: 42161, usd: 50 },
      ],
    },
    { symbol: "ETH", usd: 40.4, perChain: [{ chainId: 1, usd: 40.4 }] },
    { symbol: "SOL", usd: 22, perChain: [{ chainId: 101, usd: 22 }] },
  ],
  asOf: new Date().toISOString(),
} as const;

/** Beat 2: dust sweep — "$23.11 in 5 places" (5 sources summing 23.11). The
 *  decision-surface prompt interpolates 23.11 + 5; the post-sweep headline is
 *  SWEEP_HEADLINE below. */
export const DUST_PREVIEW_23_11 = {
  totalUsd: 23.11,
  items: [
    { chainId: 1, token: "0xaaa1", symbol: "LINK", usd: 6.11 },
    { chainId: 8453, token: "0xaaa2", symbol: "DEGEN", usd: 5 },
    { chainId: 42161, token: "0xaaa3", symbol: "ARB", usd: 4 },
    { chainId: 56, token: "0xaaa4", symbol: "CAKE", usd: 4 },
    {
      chainId: 101,
      token: "BonkMint11111111111111111111111111111111111",
      symbol: "BONK",
      usd: 4,
    },
  ],
  skipped: [],
  fees: { gas: 0.03, service: 0.02, lp: 0.01, total: 0.06 },
  hasSwept: false,
  dismissed: false,
} as const;

/** Beat 2 post-sweep headline (module 11 activity row). */
export const SWEEP_HEADLINE = "+$23.11 rescued from 5 networks."; // copy-canon-allow

/** Beat 4 stored receipt (doc 08 `executedReceipt` — the deterministic
 *  sentence, NEVER LLM) and its compact rendered form (doc 11 / C4). The demo
 *  script's short line is "Bought $15.00 SPYx · funded from Base + Arbitrum ·
 *  fees $0.14 · view onchain"; the stored string carries the full fee split. */
export const EXECUTED_RECEIPT =
  "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14 (gas $0.03, service $0.08, LP $0.03) · view onchain"; // copy-canon-allow
export const EXECUTED_COMPACT =
  "Bought $15.00 of SPYx · ▲ funded from 2 sources · fees $0.14"; // copy-canon-allow

/** Beat 5 red/blocked receipt (doc 08 `blockedReceipt`; CONFLICTS #10). The
 *  rogue "$500 memecoin" attempt trips the on-chain cap. */
export const BLOCKED_RECEIPT = "Blocked: exceeds your $50 weekly cap"; // copy-canon-allow
export const ROGUE_USD = 500;

/** Finale B: heir-claim summary — "$4,812 · 14 assets · 5 sources" (doc 16
 *  §6; CONFLICTS #4 — "5", the 5 EVM networks; Solana is out of estate v1). */
export const CLAIM_4812 = {
  totalUsd: 4812,
  assetCount: 14,
  sourceCount: 5,
  perChain: [] as { chainId: number; network: string; usd: number; assets: [] }[],
} as const;

/** Beat 3 utterance. The canonical demo line names "my sister" with no email,
 *  but the legacy schema requires `beneficiaryEmail` (HANDOFF module 09 open
 *  question — doc 16 owns the typed demo text). Decision: type it WITH an
 *  email so the live parse validates; the CI beat mocks the parse regardless. */
export const DEMO_UTTERANCE =
  "Invest $25 a week — mostly S&P, some Tesla. Stop if I drop 15%. If I go quiet for 6 months, it all goes to my sister at sister@example.com.";

/** Beat 3 mocked `intent.parse` response — one utterance → three policy cards
 *  (mirrors the agents.spec shape). Used to drive the C5→C3 render in CI; the
 *  live parse (a manual gate, doc 09) produces the same three sections. */
export const DEMO_INTENT_DRAFT = {
  ok: true as const,
  draftId: "00000000-0000-0000-0000-0000000000d0",
  confidenceNote: "Here's what I understood — check the numbers",
  adviceFooter: true,
  draft: {
    broker: {
      cadence: "weekly",
      amountUsd: 25,
      basket: [
        { assetId: "spyx", pct: 60 },
        { assetId: "tslax", pct: 30 },
        { assetId: "sol", pct: 10 },
      ],
    },
    guardian: { maxDrawdownPct: 15 },
    legacy: { beneficiaryEmail: "sister@example.com", inactivityDays: 180 },
  },
} as const;

/** Finale B claim token — the deterministic link the seeded heir email points
 *  at (`/claim/<DEMO_CLAIM_TOKEN>`). Fixed (not `mintClaimToken`) so re-seeding
 *  is idempotent. The DB stores only its sha256 hash (never the token). */
export const DEMO_CLAIM_TOKEN = "demo0claim0token0finaleb00000000";

/** The mixed three-asset-class basket (doc 20 F13 breadth beat) — re-exported
 *  from feed-seed so the demo has one basket source of truth. */
export { MIXED_BASKET_PARAMS as MIXED_BASKET };

const CLAIM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // @retenix/shared CLAIM_TOKEN_TTL_MS
// Event type strings mirrored from @retenix/shared ESTATE_EVENTS (inlined —
// see file header on why @retenix/* is not imported here).
const ESTATE_ENROLLED = "estate.enrolled";
const ESTATE_CLAIM_EMAIL_SENT = "estate.claim_email_sent";

/** `claimTokenHash` from @retenix/shared: sha256(utf8(token)), 0x-hex. Inlined
 *  with node crypto (ethers' sha256 is byte-identical to this). */
function claimTokenHash(token: string): string {
  return "0x" + createHash("sha256").update(token, "utf8").digest("hex");
}

/** users.email_hash format is sha256(lowercase(email)); the keeper compares
 *  claimStart's session against this. For the seeded heir link. */
function emailHash(email: string): string {
  return "0x" + createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Per-user seed helpers — reused by BOTH the golden-path CI spec (against an
// ephemeral test user) and the staging accounts below. Each composes the
// module-11/12/14 feed-seed primitives so the REAL routes render.
// ---------------------------------------------------------------------------

/** Owner holdings: a finished SPYx buy (beat-4 receipt + a real holding row),
 *  a tokenized-gold (PAXG) position with its disclosure line (doc 20), and a
 *  short snapshot series so the portfolio chart + sparkline render. Buying
 *  power ($212.40) and dust ($23.11) are LIVE-onchain — fund them separately
 *  (owner: `pnpm --filter @retenix/ua seed:dust` + manual USDC across 4 nets). */
export async function seedOwnerHoldings(user: TestUser): Promise<void> {
  const { jobId } = await seedPlanWithJob(user); // BROKER_PARAMS: $25/wk SPYx
  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED_RECEIPT,
    uaTxId: `demo-spyx-${randomUUID()}`,
    feesJson: { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 },
    quoteJson: { fill: { assetId: "spyx", usd: 15, qty: 0.024 } },
    createdAt: new Date(Date.now() - 3_600_000),
  });
  await seedGoldHolding(user, { usd: 5, createdAt: new Date(Date.now() - 7_200_000) });

  const hourMs = 3_600_000;
  const top = Math.floor(Date.now() / hourMs) * hourMs;
  for (const [i, totalUsd] of [44.5, 45.1, 46.02].entries()) {
    await seedSnapshot(user, {
      totalUsd,
      perAsset: {
        spyx: { qty: 0.024, markUsd: 625.4, valueUsd: 15.4 },
        paxg: { qty: 0.00125, markUsd: 4000, valueUsd: 5 },
      },
      at: new Date(top - (2 - i) * hourMs),
    });
  }
}

/** Beat 5: a blocked "$500 memecoin" execution that renders proudly (the
 *  guardian moment). In CI this stands in for the live rogue endpoint; live,
 *  the same row is produced by `POST /internal/demo/rogue` (worker DEMO_MODE)
 *  or `pnpm --filter worker rehearse:rogue`. */
export async function seedRogueBlocked(user: TestUser): Promise<void> {
  const { planId, jobId } = await seedPlanWithJob(user);
  await seedExecution(jobId, {
    status: "blocked",
    receiptText: BLOCKED_RECEIPT,
    quoteJson: { rogue: { usd: ROGUE_USD, assetId: "memecoin" } },
  });
  // The guardian's work is SEEN — the plan's C3 card flashes on /agents.
  await seedEvent(user, "execution.blocked", {
    planId,
    jobId,
    reason: "OverPeriodCap",
    legUsd: ROGUE_USD,
  });
}

/** Beat 2 post-sweep: the "+$23.11 rescued from 5 networks." feed headline
 *  (module 11 renders it from a sweep.receipt event). Live, the real sweep
 *  writes this after the one-tap confirmation completes. */
export async function seedSweepReceipt(user: TestUser): Promise<void> {
  await seedEvent(user, "sweep.receipt", {
    headline: SWEEP_HEADLINE,
    rescuedUsd: 23.11,
    networkCount: 5,
  });
}

/** Finale B: the estate side. Inserts (1) an `estates` row so the OWNER's
 *  /legacy reads enrolled + a live demo countdown (readEstateView serves the
 *  cache when the chain read is unavailable — module 14), and (2) a
 *  `claim_email_sent` event carrying the $4,812 summary + the deterministic
 *  token hash, so the HEIR's `/claim/<DEMO_CLAIM_TOKEN>` landing renders
 *  "$4,812 · 14 assets · 5 sources" straight from the DB. The live claim
 *  EXECUTION (moving funds) is owner/keeper-run against a really-enrolled
 *  estate — `beneficiary_email_enc` here is a labelled render fixture. */
export async function seedEstateClaim(user: TestUser): Promise<void> {
  const nowIso = new Date().toISOString();
  // demo timers (DEMO_INACTIVITY_SECS=120): a live countdown, past deadline,
  // claim opening shortly — the Finale-B "inactivity elapses" shape.
  const cache = {
    status: "countdown",
    lastCheckIn: new Date(Date.now() - 130_000).toISOString(),
    deadlineAt: new Date(Date.now() - 10_000).toISOString(),
    claimReadyAt: new Date(Date.now() + 48_000).toISOString(),
    inactivitySecs: 120,
    demoScaled: true,
    updatedAt: nowIso,
    lastObservedTxAt: null,
  };
  await dbQuery(
    `insert into estates (user_id, contract_state_cache, beneficiary_email_enc, tuples_enc, refreshed_at)
       values ($1, $2, $3, $4, now())
     on conflict (user_id) do update set
       contract_state_cache = excluded.contract_state_cache,
       beneficiary_email_enc = excluded.beneficiary_email_enc,
       tuples_enc = excluded.tuples_enc,
       refreshed_at = now()`,
    [
      user.userId,
      JSON.stringify(cache),
      // Render fixture (non-null): the LIVE claim uses the real enroll ceremony
      // (Magic-signed tuples, KMS envelope); the seed never decrypts this.
      "demo-seed:beneficiary-envelope (render fixture; live claim re-enrols)",
      null,
    ],
  );

  // The heir-claim landing reads THIS event (estate.claimInfo), not the
  // estates row — so `/claim/<DEMO_CLAIM_TOKEN>` shows the summary + owner name.
  await dbQuery(
    `insert into events (user_id, type, payload_json, created_at)
       values ($1, $2, $3, now())`,
    [
      user.userId,
      ESTATE_CLAIM_EMAIL_SENT,
      JSON.stringify({
        tokenHash: claimTokenHash(DEMO_CLAIM_TOKEN),
        expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString(),
        summary: CLAIM_4812,
        ownerName: "Amaka",
        beneficiaryEmailHash: emailHash("sister@example.com"),
      }),
    ],
  );

  // A feed breadcrumb + display-only snapshot valuing the estate at $4,812.
  await seedSnapshot(user, {
    totalUsd: CLAIM_4812.totalUsd,
    perAsset: { estate: { qty: 1, markUsd: CLAIM_4812.totalUsd, valueUsd: CLAIM_4812.totalUsd } },
    at: new Date(),
  });
  void ESTATE_ENROLLED; // (the enrolled receipt event is written by the live enroll ceremony)
}

// ---------------------------------------------------------------------------
// Deterministic staging accounts — stable rows (so re-seeding is idempotent and
// the demo-day "reset seed" step is a re-run). Prefixed `0xdem0` so the sweep
// below can target ONLY demo rows (never a real user, never an 0xe2e test user).
// ---------------------------------------------------------------------------

const DEMO_PREFIX = "0xdem0";
function demoAddrs(role: string): { emailHash: string; eoa: string } {
  return {
    emailHash: (DEMO_PREFIX + role).padEnd(66, "0"),
    eoa: (DEMO_PREFIX + role).padEnd(42, "0"),
  };
}

async function upsertDemoUser(role: string, region: string): Promise<TestUser> {
  const { emailHash: eh, eoa } = demoAddrs(role);
  const { rows } = await dbQuery<{ id: string }>(
    `insert into users (email_hash, eoa_addr, ua_evm_addr, ua_sol_addr, region)
       values ($1, $2, '', '', $3)
     on conflict (email_hash) do update set region = excluded.region
     returning id`,
    [eh, eoa, region],
  );
  return { userId: rows[0].id, eoa, emailHash: eh };
}

/** Owner demo account: region non-restricted (DE) + gate pre-passed, holdings
 *  seeded, no live plans (beat 3 creates them live). */
export async function seedOwnerAccount(): Promise<TestUser> {
  const owner = await upsertDemoUser("owner", "DE");
  await seedOwnerHoldings(owner);
  return owner;
}

/** Estate stage account (Finale B): enrolled + demo timers + $4,812 positions +
 *  heir inbox ready. */
export async function seedEstateAccount(): Promise<TestUser> {
  const estate = await upsertDemoUser("estate", "DE");
  await seedEstateClaim(estate);
  return estate;
}

/** The beat-4 scheduled-window plan (PS-F4-AC1 rehearsal): a broker plan with a
 *  near-future run so a live scheduled buy can land during the demo window.
 *  The live one-cycle run is `pnpm --filter worker rehearse:staging`. */
export async function seedStagingPlan(owner: TestUser): Promise<void> {
  const planId = await seedPlan(owner, {
    kind: "broker",
    status: "active",
    params: {
      ...BROKER_PARAMS,
      nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  void planId;
}

/** FK-ordered wipe of the demo accounts (mirrors sweepTestUsers) — makes
 *  `main()` idempotent and powers the demo-day "reset seed" step. */
export async function resetDemo(): Promise<void> {
  const like = `${DEMO_PREFIX}%`;
  await dbQuery(
    `delete from executions where job_id in (
       select j.id from jobs j join plans p on p.id = j.plan_id
       join users u on u.id = p.user_id where u.email_hash like $1)`,
    [like],
  );
  await dbQuery(
    `delete from jobs where plan_id in (
       select p.id from plans p join users u on u.id = p.user_id
        where u.email_hash like $1)`,
    [like],
  );
  await dbQuery(
    `delete from plans where user_id in (select id from users where email_hash like $1)`,
    [like],
  );
  await dbQuery(
    `delete from events where user_id in (select id from users where email_hash like $1)`,
    [like],
  );
  await dbQuery(
    `delete from portfolio_snapshots where user_id in (select id from users where email_hash like $1)`,
    [like],
  );
  await dbQuery(
    `delete from estates where user_id in (select id from users where email_hash like $1)`,
    [like],
  );
  await dbQuery(`delete from users where email_hash like $1`, [like]);
}

async function main(): Promise<void> {
  console.log("[seed:demo] resetting demo accounts…");
  await resetDemo();
  const owner = await seedOwnerAccount();
  await seedStagingPlan(owner);
  const estate = await seedEstateAccount();
  console.log(`[seed:demo] owner   userId=${owner.userId}  (region DE, holdings + gold)`);
  console.log(`[seed:demo] estate  userId=${estate.userId}  ($4,812 across 5 nets)`);
  console.log(`[seed:demo] heir link: /claim/${DEMO_CLAIM_TOKEN}`);
  console.log(
    "[seed:demo] DB surfaces seeded. Live-onchain figures — buying power $212.40 " +
      "(4 nets) + dust $23.11 (5 nets) + estate $4,812 — are owner-funded; see fn headers.",
  );
  console.log("[seed:demo] OK");
}

// Only run when invoked directly (`tsx e2e/seed/demo.ts`); importing this file
// from the golden-path spec must NOT execute main(). Uses argv[1] (not
// import.meta) so the module stays CommonJS-safe when Playwright imports it.
const invokedDirectly =
  Boolean(process.argv[1]) && /seed[/\\]demo\.ts$/.test(process.argv[1]!);
if (invokedDirectly) {
  main()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error("[seed:demo] error:", err instanceof Error ? err.stack : String(err));
      await closeDb();
      process.exit(1);
    });
}
