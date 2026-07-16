import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";
import { emptyPortfolioMocks, mockTrpc } from "./support/trpc-mock";

/*
 * C1/C2/BreakdownSheet (doc 06): PS-F2-AC1 (<5s warm hero), PS-F2-AC3 (live
 * source count), breakdown a11y, reduced-motion. account.summary and
 * sweep.preview are route-mocked at realistic latency — these specs measure
 * OUR pipeline (skeleton → hero), not Particle's; the live-Particle variant
 * is an owner-run item (needs a funded account + real creds, doc 16).
 */

// Demo beat 1's shape: $212.40 sourced from 4 networks (PS-6.1).
const SUMMARY = {
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
};

const EMPTY_PREVIEW = {
  totalUsd: 0,
  items: [],
  skipped: [],
  fees: { gas: 0, service: 0, lp: 0, total: 0 },
  hasSwept: false,
  dismissed: false,
};

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let user: TestUser;

test.beforeEach(async ({ context, page }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockTrpc(
    page,
    {
      ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
      "sweep.preview": () => EMPTY_PREVIEW,
    },
    { delayMs: 400 }, // realistic quote latency; the skeleton must be visible first
  );
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

const hero = (page: import("@playwright/test").Page) =>
  page.locator(".text-display-xl").filter({ hasText: "$212" });

test("PS-F2-AC1: warm login renders the hero in < 5s, skeleton first", async ({
  page,
}) => {
  // Warm the dev-server compile so the measurement is the product, not Turbopack.
  await page.goto("/home");
  await expect(hero(page)).toBeVisible();

  const started = Date.now();
  await page.goto("/home");
  await expect(hero(page)).toBeVisible();
  const elapsed = Date.now() - started;
  console.log(`[AC1] login → hero rendered in ${elapsed}ms (budget 5000ms)`);
  expect(elapsed).toBeLessThan(5_000);

  // The amount announces politely, never assertively (DS-10.8). (Next's own
  // route announcer is assertive by design — the rule is about money.)
  const live = page.locator('[aria-live="polite"]').filter({ hasText: "$212" });
  await expect(live.first()).toBeAttached();
  await expect(
    page.locator('[aria-live="assertive"]').filter({ hasText: "$" }),
  ).toHaveCount(0);
});

test("skeleton renders before the amount (never a spinner over money)", async ({
  page,
}) => {
  // A deliberately slow balance answer holds the skeleton long enough to
  // observe under parallel-suite load (still far inside the 5s budget).
  await mockTrpc(
    page,
    {
      ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
      "sweep.preview": () => EMPTY_PREVIEW,
    },
    { delayMs: 1_500 },
  );
  await page.goto("/home");
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(hero(page)).toBeVisible();
});

test("PS-F2-AC3: the pill shows the live source count and opens the breakdown", async ({
  page,
}) => {
  await page.goto("/home");
  const pill = page.getByRole("button", { name: /funded from 4 sources/ });
  await expect(pill).toBeVisible();

  // ≥24px target (DS-10 2.5.8).
  const box = await pill.boundingBox();
  expect(box && box.height).toBeGreaterThanOrEqual(24);

  await pill.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  // Networks are NAMED here — the only place — with amounts and %.
  await expect(sheet).toContainText("Base");
  await expect(sheet).toContainText("$100.00");
  await expect(sheet).toContainText("47.08%");
  await expect(sheet).toContainText("Arbitrum");
  await expect(sheet).toContainText("Ethereum");
  await expect(sheet).toContainText("Solana");
  // Per-asset rows with per-network provenance.
  await expect(sheet).toContainText("USDC");
  await expect(sheet).toContainText("$150.00");
});

test("the pill count is live data, not copy — 2 sources reads 2", async ({
  page,
}) => {
  await mockTrpc(page, {
    ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
    "account.summary": () => ({
      ...SUMMARY,
      buyingPowerUsd: 150,
      sources: SUMMARY.sources.slice(0, 2),
    }),
    "sweep.preview": () => EMPTY_PREVIEW,
  });
  await page.goto("/home");
  await expect(
    page.getByRole("button", { name: /funded from 2 sources/ }),
  ).toBeVisible();
});

test("breakdown sheet is keyboard-navigable and axe-clean", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("button", { name: /funded from 4 sources/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  // Radix traps focus inside; the close control is reachable by keyboard.
  await page.keyboard.press("Tab");
  const focusedInsideSheet = await sheet.evaluate((el) =>
    el.contains(document.activeElement),
  );
  expect(focusedInsideSheet).toBe(true);

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"]) // OKLCH tokens mis-parse in axe (module 02 note)
    .analyze();
  expect(results.violations).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("PS-F2-AC1 (live source): the real balance pipeline renders < 5s warm", async ({
  page,
  context,
}) => {
  // No mocks: session → gatedProcedure → getPrimaryAssets against Particle.
  // A fresh test EOA correctly reads $0.00; the measurement is the pipeline.
  await page.unroute("**/api/trpc/**"); // drop the beforeEach mock — live route
  const liveUser = await createTestUser("DE");
  try {
    await signIn(context, liveUser, "DE");
    await page.goto("/home"); // warm the compile + session path
    await page.waitForLoadState("networkidle");

    const started = Date.now();
    await page.goto("/home");
    const hero = page.locator(".text-display-xl").filter({ hasText: "$" });
    const unavailable = page.getByText("We can’t show your balance right now");
    await expect(hero.or(unavailable).first()).toBeVisible();
    const elapsed = Date.now() - started;

    if (await unavailable.isVisible().catch(() => false)) {
      test.skip(
        true,
        "balance source unavailable — real Particle credentials required (owner-run, doc 16)",
      );
      return;
    }
    console.log(`[AC1 live] login → hero rendered in ${elapsed}ms (budget 5000ms)`);
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    await deleteTestUser(liveUser);
  }
});

test("reduced motion renders the final value instantly (WCAG 2.3.3 / C39)", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/home");
  await expect(hero(page)).toBeVisible();
  // The full final amount is announced from the first paint.
  await expect(
    page.locator('[aria-live="polite"]').filter({ hasText: "$212.40" }).first(),
  ).toBeAttached();
});
