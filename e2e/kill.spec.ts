import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedEvent } from "./support/feed-seed";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";
import { emptyPortfolioMocks, mockTrpc } from "./support/trpc-mock";

/*
 * C7 kill switch (doc 13) — Finale A beat 6A structure. Magic cannot sign in
 * a minted-session headless browser (module 02's documented limit), so —
 * exactly the module-06 posture — these specs assert the surface to the
 * honest failure state, drive the progress/completion UI through mocked
 * kill.status, and assert the feed rows from seeded events; the
 * revoke/leg/receipt SEMANTICS are DB-proven in kill.test.ts, and the live
 * mainnet kill is owner-run (verify-kill script).
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Verbatim C7 copy (doc 13 hard constraint) — asserted byte-for-byte.
const C7_COPY =
  "Everything you hold becomes USDC in your balance. All agents lose authority. Nothing leaves your account.";

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

const KILL_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

const leg = (over: Record<string, unknown> = {}) => ({
  legId: randomUUID(),
  kind: "sell",
  assetId: "spyx",
  symbol: "SPYx",
  network: "Solana",
  chainId: 101,
  usdEst: 32.5,
  outcome: "submitted",
  attempt: 1,
  ...over,
});

const statusResponse = (over: Record<string, unknown> = {}) => ({
  killId: KILL_ID,
  legs: [
    leg({ symbol: "SPYx", outcome: "settled", usd: 32.11 }),
    leg({ symbol: "TSLAx", assetId: "tslax", outcome: "submitted" }),
    leg({
      symbol: "ETH",
      assetId: "eth",
      kind: "convert",
      chainId: 42161,
      network: "Arbitrum",
      usdEst: 9.8,
      outcome: "failed",
      error: "quote expired",
    }),
  ],
  revoked: true,
  revoke: { state: "confirmed", txHash: "0xr" },
  skipped: [],
  receipt: null,
  done: false,
  marks: { tapAtMs: null, holdCompletedAtMs: null, lastSubmittedAtMs: null },
  ...over,
});

/** The /kill surface's own queries, mocked (prepare → an active kill). */
function killMocks(status: Record<string, unknown>) {
  return {
    "kill.prepare": () => ({
      needsRevoke: false,
      digest: null,
      nonce: null,
      activeKillId: KILL_ID,
      lastKillId: KILL_ID,
    }),
    "kill.status": () => status,
    "kill.execute": () => ({
      killId: KILL_ID,
      resumed: true,
      revoke: { state: "confirmed" },
      workItems: [],
      polling: [],
      skipped: [],
    }),
    "sweep.preview": () => ({
      totalUsd: 0,
      items: [],
      skipped: [],
      fees: { gas: 0, service: 0, lp: 0, total: 0 },
      hasSwept: false,
      dismissed: false,
    }),
  };
}

async function gotoKill(page: Page, status: Record<string, unknown>) {
  await mockTrpc(page, { ...emptyPortfolioMocks, ...killMocks(status) });
  await page.goto("/kill");
}

// ---------------------------------------------------------------------------

test("Home header entry → full-screen crimson surface with the verbatim copy", async ({
  page,
}) => {
  await mockTrpc(page, {
    ...emptyPortfolioMocks,
    "account.summary": () => ({
      buyingPowerUsd: 0,
      sources: [],
      assets: [],
      asOf: new Date().toISOString(),
    }),
    "sweep.preview": () => ({
      totalUsd: 0,
      items: [],
      skipped: [],
      fees: { gas: 0, service: 0, lp: 0, total: 0 },
      hasSwept: false,
      dismissed: false,
    }),
    "kill.prepare": () => ({
      needsRevoke: false,
      digest: null,
      nonce: null,
      activeKillId: null,
      lastKillId: null,
    }),
  });
  await page.goto("/home");

  const entry = page.getByRole("link", { name: "Liquidate & Lock" });
  await expect(entry).toBeVisible();
  await entry.click();
  await page.waitForURL("**/kill");

  // Full-screen crimson, outside tab chrome: no TabBar on this surface.
  await expect(page.getByRole("heading", { name: "Liquidate & Lock" })).toBeVisible();
  await expect(page.getByText(C7_COPY, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);

  // The hold affordance is there; the timer digits are tabular (.tnum, G13).
  const hold = page.getByRole("button", { name: "Press and hold to liquidate and lock" });
  await expect(hold).toBeVisible();
  await expect(hold.locator(".tnum")).toHaveText("1.5s");
});

test("early release cancels the hold; a full hold reaches the honest failure state", async ({
  page,
}) => {
  await gotoKill(page, statusResponse());
  // Force the idle branch: no active kill for this part.
  await mockTrpc(page, {
    ...emptyPortfolioMocks,
    ...killMocks(statusResponse()),
    "kill.prepare": () => ({
      needsRevoke: false,
      digest: null,
      nonce: null,
      activeKillId: null,
      lastKillId: null,
    }),
  });
  await page.goto("/kill");

  const hold = page.getByRole("button", { name: "Press and hold to liquidate and lock" });
  await expect(hold).toBeVisible();

  // Early release (500 ms < 1.5 s) cancels — still idle, nothing started.
  const box = (await hold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect(page.getByText("Press and hold", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);

  // A full 1.5 s hold completes → the runner starts → Magic cannot sign in
  // this browser → the HONEST error state (nothing silent, nothing fake).
  await page.mouse.down();
  await page.waitForTimeout(2000);
  await page.mouse.up();
  // (p[role=alert], not getByRole — Next's route announcer is an alert too.)
  await expect(page.locator("p[role='alert']")).toContainText(
    /Couldn't start|positions/i,
    { timeout: 15_000 },
  );
  // The surface offers the hold again — retryable, no dead end.
  await expect(hold).toBeVisible();
});

test("keyboard path (DS-10.8): Enter arms, a confirm button completes, Escape disarms", async ({
  page,
}) => {
  await mockTrpc(page, {
    ...emptyPortfolioMocks,
    ...killMocks(statusResponse()),
    "kill.prepare": () => ({
      needsRevoke: false,
      digest: null,
      nonce: null,
      activeKillId: null,
      lastKillId: null,
    }),
  });
  await page.goto("/kill");

  const hold = page.getByRole("button", { name: "Press and hold to liquidate and lock" });
  await hold.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("button", { name: "Confirm — Liquidate & Lock" });
  await expect(confirm).toBeVisible();

  // Escape disarms (releasing early cancels — the keyboard equivalent).
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);

  // Arm again and confirm → the honest failure state (no Magic here).
  await page.keyboard.press("Enter");
  await confirm.click();
  await expect(page.locator("p[role='alert']")).toBeVisible({ timeout: 15_000 });
});

test("reduced motion: static progress text, no ticking countdown", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockTrpc(page, {
    ...emptyPortfolioMocks,
    ...killMocks(statusResponse()),
    "kill.prepare": () => ({
      needsRevoke: false,
      digest: null,
      nonce: null,
      activeKillId: null,
      lastKillId: null,
    }),
  });
  await page.goto("/kill");

  const hold = page.getByRole("button", { name: "Press and hold to liquidate and lock" });
  await expect(hold).toBeVisible();
  // The countdown numerals never render under reduced motion — the 1.5 s
  // timer runs with static text instead (doc 13 step 2).
  await expect(hold.locator(".tnum")).toHaveCount(0);
  await expect(page.getByText("Press and hold", { exact: true })).toBeVisible();
});

test("progress list: live region, per-leg states, retry chip on the failed leg", async ({
  page,
}) => {
  await gotoKill(page, statusResponse());

  // The resume path lands directly in the progress view (rows are the truth).
  const list = page.locator("ul[aria-live='polite']");
  await expect(list).toBeVisible();
  await expect(list.locator("li")).toHaveCount(3);

  await expect(list).toContainText("SPYx");
  await expect(list).toContainText("Done");
  await expect(list).toContainText("TSLAx");
  await expect(list).toContainText("Sent");
  await expect(list).toContainText("ETH");
  await expect(list).toContainText("Didn't complete");

  // Exactly one retry chip — on the failed leg (PS-F6-AC2).
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);

  // Revocation state renders honestly.
  await expect(page.getByText("All agents revoked.")).toBeVisible();

  // Leg amounts are tabular (G13).
  await expect(list.locator(".tnum").first()).toBeVisible();
});

test("completion: calm copy, honest aggregate, skipped list — and axe-clean", async ({
  page,
}) => {
  const done = statusResponse({
    legs: [
      leg({ symbol: "SPYx", outcome: "settled", usd: 32.11 }),
      leg({ symbol: "TSLAx", assetId: "tslax", outcome: "settled", usd: 31.9 }),
      leg({
        symbol: "ETH",
        assetId: "eth",
        kind: "convert",
        outcome: "failed",
        error: "quote expired",
      }),
    ],
    receipt: "Liquidated 2 of 3 positions to USDC · all agents revoked · 1 leg needs retry",
    done: true,
    skipped: [{ assetId: "bnb", symbol: "BNB", usd: 0.3, reason: "below-floor" }],
  });
  await gotoKill(page, done);

  // The calm completion state (PROPOSED copy, verbatim; G15: no fireworks).
  await expect(
    page.getByText("Everything is USDC. Your staff is dismissed.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Liquidated 2 of 3 positions to USDC · all agents revoked · 1 leg needs retry",
      { exact: true },
    ),
  ).toBeVisible();

  // Continue-and-report: enumeration skips are listed, never silent.
  await expect(page.getByText("Left as-is (too small to liquidate):")).toBeVisible();
  await expect(page.getByText("BNB")).toBeVisible();

  // The failed leg still offers retry — forever, without re-arming the hold.
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Back to Home" })).toBeVisible();

  // WCAG 2.2 AA sweep on the crimson surface (color-contrast is asserted by
  // scripts/contrast.ts — axe mis-parses the OKLCH tokens, module 02 note).
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Finale A beat 6A — kill rows land in the activity feed with legs and honest counts", async ({
  page,
}) => {
  // Seed what a completed kill writes (the router semantics are DB-proven in
  // kill.test.ts; this asserts the FEED renders them — doc 11's contract).
  const killId = randomUUID();
  await seedEvent(user, "kill.leg", {
    killId,
    legId: randomUUID(),
    kind: "sell",
    assetId: "spyx",
    symbol: "SPYx",
    chainId: 101,
    network: "Solana",
    usdEst: 32.5,
    outcome: "settled",
    attempt: 1,
    qty: 0.05,
    usd: 32.11,
    transactionId: "killtx1234567890",
    receipt: "Sold SPYx — now USDC in your balance.",
  });
  await seedEvent(user, "kill.receipt", {
    killId,
    receipt: "Liquidated 1 of 2 positions to USDC · all agents revoked · 1 leg needs retry",
    liquidated: 1,
    total: 2,
    retryable: 1,
    revoked: true,
    fees: { gas: 0.02, service: 0.05, lp: 0.01, total: 0.08 },
    legs: [
      {
        chainId: 101,
        network: "Solana",
        symbol: "SPYx",
        usd: 32.11,
        outcome: "settled",
        serverVerified: true,
        transactionId: "killtx1234567890",
      },
      {
        chainId: 42161,
        network: "Arbitrum",
        symbol: "ETH",
        usd: 9.8,
        outcome: "failed",
        serverVerified: false,
        error: "quote expired",
      },
    ],
    createdAt: new Date().toISOString(),
  });
  await seedEvent(user, "plan.revoked", {
    planId: randomUUID(),
    receipt: "Your Broker was dismissed — it can no longer act.",
    kind: "broker",
  });

  await page.goto("/activity");

  // The aggregate renders verbatim; expanding shows the per-leg detail.
  const aggregate = page.getByRole("button", {
    name: /Liquidated 1 of 2 positions to USDC/,
  });
  await expect(aggregate).toBeVisible();
  await aggregate.click();
  await expect(page.getByText("Solana · SPYx")).toBeVisible();
  await expect(page.getByText("Arbitrum · ETH")).toBeVisible();

  // The per-leg receipt and the plan dismissal are their own honest rows.
  await expect(page.getByText("Sold SPYx — now USDC in your balance.")).toBeVisible();
  await expect(
    page.getByText("Your Broker was dismissed — it can no longer act."),
  ).toBeVisible();
});
