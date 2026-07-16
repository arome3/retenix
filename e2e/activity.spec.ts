import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  seedEvent,
  seedExecution,
  seedPlanWithJob,
} from "./support/feed-seed";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";

/*
 * S4 · Activity (doc 11) — demo beats 4 and 5 plus the module's DoD checks:
 * poll arrival with the 250ms slide-in, expansion forensics (fee split that
 * sums, named sources, universalx link, policy link → C3 card), the blocked
 * receipt rendered proudly + the S3 card flash, the WCAG 2.2.2 pause, filter
 * chips, day dividers, degradation copy, list semantics and axe.
 *
 * Sentences are seeded as the CANONICAL strings (their byte-tie to
 * packages/shared/receipts.ts is pinned in the unit layers — receipts.test.ts
 * and feed.test.ts; the e2e layer asserts the DOM renders them verbatim).
 */

const EXECUTED =
  "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14 (gas $0.03, service $0.08, LP $0.03) · view onchain";
const EXECUTED_COMPACT = "Bought $15.00 of SPYx · ▲ funded from 2 sources · fees $0.14";
const BLOCKED = "Blocked: exceeds your $50 weekly cap"; // CONFLICTS #10
const REFUNDED = "Didn't complete — your $15.00 was returned";
const HIRED = "Your Broker is hired — $25.00 every week across SPYx.";
const SWEEP_HEADLINE = "+$23.11 rescued from 5 networks.";
const FEES = { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 };
const TX_ID = "e2etx1234567890abcd";
const QUOTE_JSON = {
  uaDetail: { depositTokens: [{ chainId: 8453 }, { chainId: 42161 }] },
};

// The poll is 20s (PROPOSED, doc 11) — arrival assertions allow one tick.
const POLL_WAIT = 25_000;

// S4 chrome is a decision surface (G12); the FEED CONTENT is the sanctioned
// receipt context where networks may be named — scans subtract it.
const BANNED = [
  /\bseed[\s-]?phrases?\b/i,
  /\bwallets?\b/i,
  /\bgas\b/i,
  /\bnetworks?\b/i,
  /\bbridg(?:e|es|ed|ing)\b/i,
  /\bslippage\b/i,
  /\bsmart[\s-]contracts?\b/i,
  /\bdelegat(?:e|es|ed|ing|ion|ions)\b/i,
  /\bsign transaction/i,
];

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("US");
  await signIn(context, user, "US");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

async function chromeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelector('ul[aria-label="Activity feed"]')?.remove();
    return clone.textContent ?? "";
  });
}

test("empty state: etching copy, no banned vocabulary, axe clean", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByText("Your staff's work shows up here.")).toBeVisible();

  const body = (await page.locator("body").textContent()) ?? "";
  for (const re of BANNED) {
    expect(body, `banned vocabulary ${re}`).not.toMatch(re);
  }

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test("beat 4: a staged execution slides in within the poll interval; expansion shows the full forensics", async ({ page }) => {
  test.setTimeout(90_000);
  const { jobId } = await seedPlanWithJob(user);

  await page.goto("/activity");
  await expect(page.getByText("Your staff's work shows up here.")).toBeVisible();

  // The receipt lands AFTER the page is watching — beat 4's liveness.
  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED,
    uaTxId: TX_ID,
    feesJson: FEES,
    quoteJson: QUOTE_JSON,
  });

  // Arrives ≤ one poll tick, wearing the 250ms entrance (the class is the
  // slide-in token --animate-receipt-in).
  await expect(
    page.locator(".animate-receipt-in", { hasText: "Bought $15.00 of SPYx" }),
  ).toBeVisible({ timeout: POLL_WAIT });

  // The compact row: fee parenthetical elided, sources counted (G12), and the
  // canonical numbers intact.
  const row = page.getByRole("button", { name: /Bought \$15\.00 of SPYx/ });
  await expect(row).toContainText(EXECUTED_COMPACT);
  await expect(row).toHaveAttribute("aria-expanded", "false");

  // Expand → the split that sums to the displayed total, the named sources,
  // the verification link, and the policy link.
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  const detailId = await row.getAttribute("aria-controls");
  const detail = page.locator(`#${detailId}`);
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("gas");
  await expect(detail).toContainText("$0.03");
  await expect(detail).toContainText("service");
  await expect(detail).toContainText("$0.08");
  await expect(detail).toContainText("LP");
  await expect(detail).toContainText("$0.14"); // the reconciled total
  await expect(detail).toContainText("funded from Base + Arbitrum");
  await expect(detail.getByRole("link", { name: "view onchain" })).toHaveAttribute(
    "href",
    `https://universalx.app/activity/details?id=${TX_ID}`,
  );

  // "because you set: …" opens the plan's C3 card sheet, quoting its terms.
  const policyLink = detail.getByRole("button", { name: /because you set/ });
  await expect(policyLink).toContainText("$25.00 every week");
  await policyLink.click();
  await expect(page.getByText("The rule behind this")).toBeVisible();
  await expect(
    page.getByRole("article", { name: /broker policy/i }),
  ).toBeVisible();
});

test("beat 5: the blocked receipt renders proudly and the plan's card flashes on S3", async ({ page }) => {
  test.setTimeout(90_000);
  const { planId, jobId } = await seedPlanWithJob(user);
  await seedExecution(jobId, { status: "blocked", receiptText: BLOCKED });
  await seedEvent(user, "execution.blocked", {
    planId,
    jobId,
    reason: "OverPeriodCap",
    legUsd: 500,
  });

  await page.goto("/activity");
  const row = page.getByRole("button", { name: /Blocked: exceeds/ });
  await expect(row).toBeVisible();
  // The canonical sentence, byte-for-byte (CONFLICTS #10) — proud, not hidden.
  await expect(row).toContainText(BLOCKED);
  // The amber shield mark (—warning token; G14 keeps it distinct from loss red).
  await expect(row.locator(".text-warning")).toBeVisible();

  // The guardian is seen working: the plan's C3 card pulses on S3.
  await page.goto("/agents");
  await expect(
    page.getByRole("article", { name: /broker policy — Blocked something/i }),
  ).toBeVisible({ timeout: 20_000 });
});

test("pause freezes the feed (WCAG 2.2.2): no arrivals while paused, announced to screen readers", async ({ page }) => {
  test.setTimeout(120_000);
  const { jobId } = await seedPlanWithJob(user);

  await page.goto("/activity");
  await expect(page.getByText("Your staff's work shows up here.")).toBeVisible();

  const pauseChip = page.getByRole("button", { name: "Pause updates" });
  await pauseChip.click();
  await expect(pauseChip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText("Updates paused");

  // A receipt lands while paused — the feed must NOT update…
  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED,
    uaTxId: TX_ID,
    feesJson: FEES,
    quoteJson: QUOTE_JSON,
  });
  await page.waitForTimeout(POLL_WAIT);
  await expect(page.getByText("Bought $15.00 of SPYx")).toHaveCount(0);

  // …until resumed.
  await pauseChip.click();
  await expect(pauseChip).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Bought $15.00 of SPYx").first()).toBeVisible({
    timeout: POLL_WAIT,
  });
});

test("filters partition the feed; day dividers group it; degradation stays honest", async ({ page }) => {
  test.setTimeout(90_000);
  const { planId, jobId } = await seedPlanWithJob(user);
  const now = Date.now();
  const HOUR = 3_600_000;

  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED,
    uaTxId: TX_ID,
    feesJson: FEES,
    quoteJson: QUOTE_JSON,
    createdAt: new Date(now - 1 * HOUR),
  });
  await seedExecution(jobId, {
    status: "blocked",
    receiptText: BLOCKED,
    createdAt: new Date(now - 2 * HOUR),
  });
  // an executed row whose forensics lag (null fees_json) — settling copy
  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED,
    createdAt: new Date(now - 3 * HOUR),
  });
  await seedExecution(jobId, {
    status: "refunded",
    receiptText: REFUNDED,
    createdAt: new Date(now - 26 * HOUR), // yesterday → divider
  });
  await seedEvent(user, "plan.activated", {
    planId,
    kind: "broker",
    contractPlanId: 7,
    receipt: HIRED,
  });
  await seedEvent(user, "sweep.receipt", {
    headline: SWEEP_HEADLINE,
    fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
    legs: [
      {
        chainId: 8453,
        network: "Base",
        token: "0xabc",
        symbol: "DEGEN",
        usd: 0.61,
        transactionId: TX_ID,
        outcome: "finished",
        serverVerified: true,
        fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
        feeSource: "settled",
      },
    ],
  });

  await page.goto("/activity");

  // All: everything, grouped under day dividers.
  await expect(page.getByText(BLOCKED)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Yesterday", exact: true }),
  ).toBeVisible();

  // Chrome (everything but the receipts) carries no banned vocabulary even
  // with a populated feed — receipt text is the sanctioned exception.
  const chrome = await chromeText(page);
  for (const re of BANNED) {
    expect(chrome, `banned vocabulary in S4 chrome: ${re}`).not.toMatch(re);
  }

  // Trades = executed + failed-refunded; blocked and system are elsewhere.
  await page.getByText("Trades", { exact: true }).click();
  await expect(page.getByText(REFUNDED)).toBeVisible();
  await expect(page.getByText("Bought $15.00 of SPYx").first()).toBeVisible();
  await expect(page.getByText(BLOCKED)).toHaveCount(0);
  await expect(page.getByText(HIRED)).toHaveCount(0);

  // Blocked = the guardian's work only.
  await page.getByText("Blocked", { exact: true }).click();
  await expect(page.getByText(BLOCKED)).toBeVisible();
  await expect(page.getByText("Bought $15.00 of SPYx")).toHaveCount(0);

  // System = the rest (hires, sweeps).
  await page.getByText("System", { exact: true }).click();
  await expect(page.getByText(HIRED)).toBeVisible();
  await expect(page.getByText(SWEEP_HEADLINE)).toBeVisible();
  await expect(page.getByText(BLOCKED)).toHaveCount(0);

  // A system row shows NO fee line for absent fees — and the sweep aggregate
  // exposes its per-leg forensics.
  const hiredRow = page.getByRole("button", { name: /Your Broker is hired/ });
  await hiredRow.click();
  const hiredDetail = page.locator(`#${await hiredRow.getAttribute("aria-controls")}`);
  await expect(hiredDetail).toBeVisible();
  await expect(hiredDetail).not.toContainText("gas");
  await expect(hiredDetail).not.toContainText("$0.00");

  const sweepRow = page.getByRole("button", { name: /rescued from 5/ });
  await sweepRow.click();
  const sweepDetail = page.locator(`#${await sweepRow.getAttribute("aria-controls")}`);
  await expect(sweepDetail).toContainText("Base · DEGEN");
  await expect(sweepDetail).toContainText("Done");
  await expect(sweepDetail.getByRole("link", { name: "view onchain" })).toHaveAttribute(
    "href",
    `https://universalx.app/activity/details?id=${TX_ID}`,
  );
  // no retry chip — modules 06/13 own the retry endpoints (no callback wired)
  await expect(sweepDetail.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Back on All: the settling row degrades honestly (sentence + copy, never
  // fabricated values).
  await page.getByText("All", { exact: true }).click();
  const executedRows = page.getByRole("button", { name: /Bought \$15\.00 of SPYx/ });
  await expect(executedRows).toHaveCount(2);
  await executedRows.nth(1).click(); // the older, fee-less one
  const settlingDetail = page.locator(
    `#${await executedRows.nth(1).getAttribute("aria-controls")}`,
  );
  await expect(settlingDetail).toContainText("details are still settling");
  await expect(settlingDetail).not.toContainText("$0.00");
});

test("populated feed: list semantics, keyboard-reachable absolute time, axe clean", async ({ page }) => {
  test.setTimeout(90_000);
  const { jobId } = await seedPlanWithJob(user);
  await seedExecution(jobId, {
    status: "finished",
    receiptText: EXECUTED,
    uaTxId: TX_ID,
    feesJson: FEES,
    quoteJson: QUOTE_JSON,
  });

  await page.goto("/activity");
  const row = page.getByRole("button", { name: /Bought \$15\.00 of SPYx/ });
  await expect(row).toBeVisible();

  // Receipts are <li> items inside the labeled feed list (DS-10.8).
  await expect(
    page.locator('ul[aria-label="Activity feed"] li', {
      hasText: "Bought $15.00 of SPYx",
    }),
  ).toBeVisible();

  // Keyboard: tab to the row → the always-absolute time surfaces (tooltip on
  // focus; the expansion repeats it in plain text as the second channel).
  await page.keyboard.press("Tab");
  for (let i = 0; i < 20; i++) {
    const controls = await page
      .locator(":focus")
      .getAttribute("aria-controls")
      .catch(() => null);
    if (controls?.startsWith("receipt-detail-")) break;
    await page.keyboard.press("Tab");
  }
  await expect(
    page.getByText(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)/).first(),
  ).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

// The five presentations render distinctly in every theme; blocked amber must
// never read as loss red (G14) — proven on the dev token sheet, which renders
// the C4 fixtures next to the raw tokens with the theme switcher.
test("token sheet: blocked amber ≠ loss red in light, dark, and CVD", async ({ page }) => {
  await page.goto("/dev/tokens");
  await page.waitForLoadState("networkidle");

  const shieldColor = () =>
    page
      .locator(".animate-receipt-in, [class*='text-warning']")
      .first()
      .evaluate(() => {
        const el = document.querySelector(
          'ul li .text-warning',
        ) as HTMLElement | null;
        return el ? getComputedStyle(el).color : null;
      });
  const negativeSwatch = () =>
    page
      .getByText("negative", { exact: true })
      .locator("xpath=preceding-sibling::div[1]")
      .evaluate((el) => getComputedStyle(el).backgroundColor);

  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page.waitForTimeout(150);
    const amber = await shieldColor();
    const red = await negativeSwatch();
    expect(amber, `${theme}: shield renders`).not.toBeNull();
    expect(amber, `${theme}: amber ≠ loss red`).not.toBe(red);

    // and with Accessible colors on
    await page.getByRole("button", { name: /Accessible colors/ }).click();
    await page.waitForTimeout(150);
    const amberCvd = await shieldColor();
    const redCvd = await negativeSwatch();
    expect(amberCvd, `${theme}+cvd: amber ≠ loss red`).not.toBe(redCvd);
    await page.getByRole("button", { name: /Accessible colors/ }).click();
  }
});
