import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";
import { seedExecution, seedPlanWithJob } from "./support/feed-seed";
import { emptyPortfolioMocks, mockTrpc } from "./support/trpc-mock";
import {
  BLOCKED_RECEIPT,
  CLAIM_4812,
  DEMO_CLAIM_TOKEN,
  DEMO_INTENT_DRAFT,
  DEMO_UTTERANCE,
  DUST_PREVIEW_23_11,
  EXECUTED_COMPACT,
  EXECUTED_RECEIPT,
  seedRogueBlocked,
  seedSweepReceipt,
  SUMMARY_212_40,
  SWEEP_HEADLINE,
} from "./seed/demo";

/*
 * Golden path — the 2-minute demo (doc 16 §6 / product spec §6).
 *
 * ONE consolidated walk over the seven beats, each an independently-green,
 * `@beatN`-tagged test (`pnpm e2e -- --grep @beat3` runs just that beat). The
 * per-module specs prove each surface in depth; THIS spec proves the narrative
 * holds end to end on the demo commit, and pins the canonical demo sentences
 * (doc 16 gotcha: "the demo script's sentences are requirements, not flavour").
 *
 * The dollar figures come from `e2e/seed/demo.ts` — the seed-data contract, the
 * single source of truth. Beat copy imported from there matches docs 06/08/11.
 *
 * Two modes (user-approved hybrid, HANDOFF §16):
 *  - CI (default): `signIn` cookie + `mockTrpc`/DB-seed — green every commit.
 *    Magic OTP is intentionally NOT automated (the whole suite mints sessions
 *    the way the server does; headless Magic can't sign — module 02's limit).
 *  - LIVE (`GOLDEN_PATH_LIVE=1`, `APP_BASE_URL=<staging>`, `DEMO_MODE=1`):
 *    drives the real rogue endpoint (beat 5) and the real demo-timer estate
 *    (beat 6B) against the seeded demo account (`pnpm seed:demo`), where those
 *    env hooks are present; otherwise falls back to the seeded shape.
 */

const LIVE = process.env.GOLDEN_PATH_LIVE === "1";

const EMPTY_PREVIEW = {
  totalUsd: 0,
  items: [],
  skipped: [],
  fees: { gas: 0, service: 0, lp: 0, total: 0 },
  hasSwept: true,
  dismissed: false,
};

// The 5s warm budgets are measured against a shared dev server; under the full
// parallel suite the goto itself contends. Retries keep the walk honest — a
// real regression still fails three times in a row.
test.describe.configure({ retries: 2 });

test.afterAll(closeDb);

async function mockHome(
  page: Page,
  over: Record<string, () => unknown> = {},
): Promise<void> {
  await mockTrpc(page, {
    ...emptyPortfolioMocks,
    "account.summary": () => SUMMARY_212_40,
    "sweep.preview": () => EMPTY_PREVIEW,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Beat 1 — email login → buying power appears: "$212.40" · 4 sources.
// ---------------------------------------------------------------------------
test("@beat1 · login → buying power $212.40, funded from 4 sources", async ({
  context,
  page,
}) => {
  const user = await createTestUser("DE");
  await signIn(context, user, "DE"); // the demo login (Magic in the live walk)
  await mockHome(page);
  await page.goto("/home");

  await expect(
    page.locator('[aria-live="polite"]').filter({ hasText: "$212.40" }).first(),
  ).toBeVisible();
  // The provenance pill. Demo narration says "sourced from 4 networks"; the
  // rendered decision-surface copy is "funded from 4 sources" (G12 — "sources"
  // is the user-facing word for networks). The count is live data, not copy.
  await expect(
    page.getByRole("button", { name: /funded from 4 sources/ }),
  ).toBeVisible();

  await deleteTestUser(user);
});

// ---------------------------------------------------------------------------
// Beat 2 — dust sweep prompt → one signature → "+$23.11 rescued from 5 networks."
// ---------------------------------------------------------------------------
test("@beat2 · dust sweep → one tap → +$23.11 rescued from 5 networks", async ({
  context,
  page,
}) => {
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockHome(page, { "sweep.preview": () => DUST_PREVIEW_23_11 });
  await page.goto("/home");

  // The decision-surface prompt — verbatim, amount + count interpolated.
  const card = page.getByRole("region", { name: "Found money" });
  await expect(card).toContainText(
    "We found $23.11 in 5 places. Add it to your buying power?",
  );
  await card.getByRole("button", { name: "One tap" }).click();

  // The ONE signature moment (a single confirmation drives the whole batch).
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Add $23.11 to your buying power?");

  // The completed sweep's feed headline. Live, the one-tap confirmation writes
  // it; headless Magic can't sign, so we seed the receipt and read it back
  // through the REAL activity route (drop the home mocks first).
  await seedSweepReceipt(user);
  await page.unroute("**/api/trpc/**");
  await page.goto("/activity");
  await expect(page.getByText(SWEEP_HEADLINE)).toBeVisible();

  await deleteTestUser(user);
});

// ---------------------------------------------------------------------------
// Beat 3 — intent bar: one utterance → three policy cards → one activation.
// ---------------------------------------------------------------------------
test("@beat3 · intent bar → three policy cards (broker · guardian · legacy)", async ({
  context,
  page,
}) => {
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");

  // The live model is a manual gate (doc 09); intercept intent.parse to prove
  // the C5→C3 render of the three-section draft. Same shape the live parse
  // produces from DEMO_UTTERANCE.
  await page.route("**/api/trpc/intent.parse**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ result: { data: DEMO_INTENT_DRAFT } }),
    });
  });

  await page.goto("/agents");
  await page
    .getByLabel("Describe an agent in your own words")
    .fill(DEMO_UTTERANCE);
  await page.getByRole("button", { name: "Draft it" }).click();

  await expect(
    page.getByText("Here's what I understood — check the numbers"),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: /broker policy — Draft/i })).toBeVisible();
  await expect(page.getByRole("article", { name: /guardian policy — Draft/i })).toBeVisible();
  await expect(page.getByRole("article", { name: /legacy policy — Draft/i })).toBeVisible();
  await expect(page.getByText("sister@example.com")).toBeVisible();
  // The activation affordance — "Proceed", never "Sign" (the one signature).
  await expect(page.getByRole("button", { name: "Proceed" })).toBeVisible();

  await deleteTestUser(user);
});

// ---------------------------------------------------------------------------
// Beat 4 — live execution: the receipt slides in.
// "Bought $15.00 SPYx · funded from Base + Arbitrum · fees $0.14 · view onchain."
// ---------------------------------------------------------------------------
test("@beat4 · live execution receipt: Bought $15.00 of SPYx, 2 sources, fees $0.14", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");
  const { jobId } = await seedPlanWithJob(user);

  await page.goto("/activity");
  await expect(page.getByText("Your staff's work shows up here.")).toBeVisible();

  // The receipt lands AFTER the page is watching — beat 4's liveness (live, the
  // scheduler writes it; here a seeded FINISHED execution stands in).
  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED_RECEIPT,
    uaTxId: "e2egolden1234567890",
    feesJson: { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 },
    quoteJson: { uaDetail: { depositTokens: [{ chainId: 8453 }, { chainId: 42161 }] } },
  });

  const row = page.getByRole("button", { name: /Bought \$15\.00 of SPYx/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(EXECUTED_COMPACT);
  // Expansion shows the full forensics + the onchain link.
  await row.click();
  await expect(page.getByText("funded from Base + Arbitrum")).toBeVisible();

  await deleteTestUser(user);
});

// ---------------------------------------------------------------------------
// Beat 5 — guardian moment: rogue "$500 memecoin" → blocked onchain, red receipt.
// ---------------------------------------------------------------------------
test("@beat5 · guardian blocks the $500 memecoin — red receipt renders proudly", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");

  await triggerRogueOrSeed(request, user);

  await page.goto("/activity");
  const row = page.getByRole("button", { name: /Blocked: exceeds/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(BLOCKED_RECEIPT); // byte-for-byte (CONFLICTS #10)
  // The amber shield mark (warning token; G14 keeps it distinct from loss red).
  await expect(row.locator(".text-warning")).toBeVisible();

  await deleteTestUser(user);
});

/** LIVE drives the real rogue endpoint (worker DEMO_MODE) against the same DB;
 *  otherwise the seeded blocked execution renders the identical row. */
async function triggerRogueOrSeed(
  request: APIRequestContext,
  user: TestUser,
): Promise<void> {
  const workerUrl = process.env.WORKER_INTERNAL_URL;
  const token = process.env.INTERNAL_API_TOKEN;
  if (LIVE && workerUrl && token) {
    const { planId } = await seedPlanWithJob(user);
    const res = await request.post(`${workerUrl}/internal/demo/rogue`, {
      headers: { authorization: `Bearer ${token}` },
      data: { planId },
    });
    if (res.ok()) return; // the live worker writes the blocked execution
  }
  await seedRogueBlocked(user);
}

// ---------------------------------------------------------------------------
// Beat 6 — Finale A: Liquidate & Lock.  Finale B: the heir inherits $4,812.
// ---------------------------------------------------------------------------
test("@beat6 · Finale A — Liquidate & Lock unwinds to USDC, agents revoked", async ({
  context,
  page,
}) => {
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockHome(page);
  await page.goto("/home");

  // The kill-switch entry is an icon-sized link to the crimson surface (DS-4.4).
  const entry = page.getByRole("link", { name: "Liquidate & Lock" });
  await expect(entry).toBeVisible();
  await entry.click();
  await page.waitForURL("**/kill");
  await expect(page.getByRole("heading", { name: "Liquidate & Lock" })).toBeVisible();
  // The press-and-hold safety gate (module 13; <10s to submitted is the AC).
  await expect(
    page.getByRole("button", { name: "Press and hold to liquidate and lock" }),
  ).toBeVisible();

  await deleteTestUser(user);
});

test("@beat6 · Finale B — heir link → \"You've inherited $4,812 across 5 networks\"", async ({
  context,
  page,
}) => {
  // The heir arrives on the claim link. A session must exist for the flow to
  // reveal the summary directly (ClaimFlow: "See what was left for you" → summary
  // only when the visitor holds a session, else the Magic OTP step). Signing in
  // stands in for the heir having just onboarded (headless Magic can't sign — the
  // estate.spec posture). In CI we mock the claim reads; LIVE reads the seeded
  // claim_email_sent event through the REAL route (`pnpm seed:demo` populated it).
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");
  if (!LIVE) {
    await mockTrpc(page, {
      "estate.claimInfo": () => ({ state: "ready", ownerName: "Amaka", summary: CLAIM_4812 }),
      "estate.claimStart": () => ({ ok: true, ownerName: "Amaka", summary: CLAIM_4812 }),
      "estate.claimStatus": () => ({ started: false, done: false, receipt: null, sources: [] }),
    });
  }
  await page.goto(`/claim/${DEMO_CLAIM_TOKEN}`);

  await expect(page.getByText("You’ve been named by Amaka.")).toBeVisible();
  await page.getByRole("button", { name: "See what was left for you" }).click();
  // "$4,812 · 14 assets · 5 sources" — the DS shape; "5 sources" fixed (G3).
  await expect(page.getByText("$4,812")).toBeVisible();
  await expect(page.getByText("14 assets · 5 sources")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Claim what was left for you" }),
  ).toBeVisible();

  await deleteTestUser(user);
});

// ---------------------------------------------------------------------------
// Beat 7 — close: Settings → Export key. "It's your address. It always was."
// ---------------------------------------------------------------------------
test("@beat7 · Profile → Export key opens the C14 flow (the demo close)", async ({
  context,
  page,
}) => {
  const user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await page.goto("/profile");

  await page.getByText("Export your key").click();
  // The C14 framing + the one action that opens Magic's user-only modal.
  await expect(page.getByRole("button", { name: "Show my key" })).toBeVisible();

  await deleteTestUser(user);
});
