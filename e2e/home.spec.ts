import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";
import {
  seedExecution,
  seedPlanWithJob,
  seedSnapshot,
} from "./support/feed-seed";
import { mockTrpc } from "./support/trpc-mock";

/*
 * S2 Home (doc 12): beat-1 shape (<5s warm, skeletons first), the neutral
 * allocation ramp vs delta-text gain/loss split (G14), the TradingView
 * attribution (Apache-2.0 NOTICE) in both themes, the CVD swap, the
 * disclosure line on every equity detail, the PROPOSED empty state, and the
 * seeded chart + mini-feed against the REAL routes. portfolio.holdings /
 * account.summary are route-mocked for the funded view — these specs measure
 * OUR pipeline, not Jupiter/Particle; the live-mainnet reconciliation is the
 * owner-run staging item (doc 16, module 08's recorded posture).
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const SUMMARY = {
  buyingPowerUsd: 212.4,
  sources: [
    { chainId: 8453, name: "Base", usd: 190.4, pct: 89.64 },
    { chainId: 42161, name: "Arbitrum", usd: 22, pct: 10.36 },
  ],
  assets: [
    {
      symbol: "USDC",
      usd: 212.4,
      perChain: [
        { chainId: 8453, usd: 190.4 },
        { chainId: 42161, usd: 22 },
      ],
    },
  ],
  asOf: new Date().toISOString(),
};

const EMPTY_PREVIEW = {
  totalUsd: 0,
  items: [],
  skipped: [],
  fees: { gas: 0, service: 0, lp: 0, total: 0 },
  hasSwept: true,
  dismissed: false,
};

const SPARK = [
  28.1, 28.4, 28.2, 28.9, 29.3, 29.1, 29.8, 30.2, 30.0, 30.6, 30.4, 30.9,
  31.1, 30.8, 31.0, 31.3, 31.1, 31.2, 31.2, 31.27,
];

const HOLDINGS = {
  holdings: [
    {
      assetId: "spyx",
      ticker: "SPYx",
      name: "S&P 500 (tokenized)",
      qty: 0.05,
      qtyHuman: "0.05",
      markUsd: 625.4,
      markStale: false,
      valueUsd: 31.27,
      costBasisUsd: 30,
      deltaUsd: 1.27,
      deltaPct: 4.23,
      spark: SPARK,
      disclosure:
        "SPYx tracks the S&P 500 ETF. It is not a share — no voting rights or dividend claims. Issuer: Backed.",
    },
    {
      assetId: "sol",
      ticker: "SOL",
      name: "Solana",
      qty: 0.1,
      qtyHuman: "0.1",
      markUsd: 147.5,
      markStale: false,
      valueUsd: 14.75,
      costBasisUsd: 15.2,
      deltaUsd: -0.45,
      deltaPct: -2.96,
      spark: SPARK.slice(0, 10).map((v) => v / 2),
    },
  ],
  totalUsd: 46.02,
  costBasisUsd: 45.2,
  returnUsd: 0.82,
  returnPct: 1.81,
  asOf: new Date().toISOString(),
  unattributedBuys: 0,
};

const CHART_NOW = Math.floor(Date.now() / 1000 / 3600) * 3600;
const CHART = {
  points: [
    { t: CHART_NOW - 5 * 3600, usd: 44.9 },
    { t: CHART_NOW - 4 * 3600, usd: 45.4 },
    { t: CHART_NOW - 3 * 3600, usd: null }, // worker gap — rendered, not interpolated
    { t: CHART_NOW - 2 * 3600, usd: 45.8 },
    { t: CHART_NOW - 1 * 3600, usd: 45.95 },
  ],
  asOf: new Date().toISOString(),
};

async function mockFundedHome(page: Page, opts: { delayMs?: number } = {}) {
  await mockTrpc(
    page,
    {
      "account.summary": () => SUMMARY,
      "sweep.preview": () => EMPTY_PREVIEW,
      "portfolio.holdings": () => HOLDINGS,
      "portfolio.chart": () => CHART,
      "portfolio.topUpPrompt": () => null,
      "activity.feed": () => ({ items: [] }),
    },
    opts,
  );
}

/** Resolved color of a semantic text token, for computed-style comparisons. */
async function tokenColor(page: Page, cls: string): Promise<string> {
  return page.evaluate((className) => {
    const probe = document.createElement("span");
    probe.className = className;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, cls);
}

async function setTheme(
  page: Page,
  opts: { mode?: "light" | "dark"; cvd?: boolean },
) {
  await page.goto("/dev/tokens");
  if (opts.mode) {
    const button = page.getByRole("button", {
      name: opts.mode === "dark" ? "Dark" : "Light",
      exact: true,
    });
    // Retry-click until hydration has attached the handler (aria-pressed
    // flips only when the click actually landed) — activity.spec's lesson.
    await expect(async () => {
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 500 });
    }).toPass();
  }
  if (opts.cvd !== undefined) {
    const button = page.getByRole("button", { name: /Accessible colors/ });
    await expect(async () => {
      const pressed = (await button.getAttribute("aria-pressed")) === "true";
      if (pressed !== opts.cvd) await button.click();
      await expect(button).toHaveAttribute("aria-pressed", String(opts.cvd), {
        timeout: 500,
      });
    }).toPass();
  }
}

let user: TestUser;

test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(async () => {
  await closeDb();
});

// The 5s budget is a timing AC measured against a shared dev server; under
// the FULL parallel suite (95 specs since doc 15) the goto itself contends.
// Retries keep the assertion honest — a retry runs as the suite drains, so a
// genuine regression still fails three times in a row.
test.describe.configure({ retries: 2 });

test("beat-1 shape: skeletons first, then header + chart + ring + holdings, <5s warm", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockFundedHome(page, { delayMs: 400 });

  const t0 = Date.now();
  await page.goto("/home");

  // Chart + holdings render inside the beat-1 budget (skeletons first is fine).
  await expect(page.getByRole("group", { name: /Portfolio value/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /SPYx, S&P 500/ })).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(5000);

  // C1 header hosts the money; the kill-switch entry is live (module 13) —
  // an icon-sized link to the crimson surface, never inside tabs (DS-4.4).
  await expect(page.getByText("Buying power")).toBeVisible();
  const killEntry = page.getByRole("link", { name: "Liquidate & Lock" });
  await expect(killEntry).toBeVisible();
  await expect(killEntry).toHaveAttribute("href", "/kill");

  // The ring's legend is the accessible structure and sums to exactly 100.00.
  const legend = page.getByRole("list", { name: "Allocation" });
  await expect(legend).toBeVisible();
  const pcts = await legend.locator("li").allTextContents();
  const sum = pcts
    .map((t) => Number(/([\d.]+)%/.exec(t)?.[1] ?? "0"))
    .reduce((s, v) => s + v, 0);
  expect(sum).toBeCloseTo(100, 5);

  // TradingView attribution — Apache-2.0 NOTICE — must be in the DOM.
  await expect(page.locator("a[href*='tradingview.com']")).toBeVisible();

  // Reconciliation dev-banner agrees with itself (dev server ⇒ visible).
  await expect(page.locator("[data-reconcile='ok']")).toBeVisible();

  // Decision-surface vocabulary stays clean (G12) — scan the page copy.
  const copy = (await page.locator("main").innerText()).toLowerCase();
  for (const banned of ["gas", "bridge", "seed phrase", "wallet", "slippage", "smart contract"]) {
    expect(copy, `banned vocabulary: ${banned}`).not.toContain(banned);
  }

  const axe = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"]) // OKLCH tokens mis-parse in axe (module 02 note); scripts/contrast.ts is the authority
    .analyze();
  expect(axe.violations).toEqual([]);
});

test("G14 split: the ramp and sparkline are neutral, ONLY delta text wears gain/loss — and CVD swaps it", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockFundedHome(page);
  await setTheme(page, { mode: "dark", cvd: false });
  await page.goto("/home");
  await expect(page.getByRole("list", { name: "Allocation" })).toBeVisible();

  const positive = await tokenColor(page, "text-positive");
  const negative = await tokenColor(page, "text-negative");

  // Ring segments: stroke never equals a gain/loss token color.
  const strokes = await page
    .locator("svg[aria-hidden='true'] circle[stroke-dasharray]")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).stroke));
  expect(strokes.length).toBeGreaterThan(0);
  for (const stroke of strokes) {
    expect(stroke).not.toBe(positive);
    expect(stroke).not.toBe(negative);
  }

  // Sparkline stays muted.
  const sparkStrokes = await page
    .locator("polyline")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).stroke));
  for (const stroke of sparkStrokes) {
    expect(stroke).not.toBe(positive);
    expect(stroke).not.toBe(negative);
  }

  // Delta text DOES wear the tokens (the one sanctioned surface).
  const gainDelta = page.getByText("▲ +$1.27 (+4.23%)");
  await expect(gainDelta).toBeVisible();
  const gainColor = await gainDelta.evaluate((el) => getComputedStyle(el).color);
  expect(gainColor).toBe(positive);

  // CVD toggle swaps delta colors app-wide; the neutral ramp must not move.
  await setTheme(page, { cvd: true });
  await page.goto("/home");
  await expect(page.getByRole("list", { name: "Allocation" })).toBeVisible();
  const cvdPositive = await tokenColor(page, "text-positive");
  expect(cvdPositive).not.toBe(positive); // blue gains now
  const cvdGainColor = await page
    .getByText("▲ +$1.27 (+4.23%)")
    .evaluate((el) => getComputedStyle(el).color);
  expect(cvdGainColor).toBe(cvdPositive);
  const cvdStrokes = await page
    .locator("svg[aria-hidden='true'] circle[stroke-dasharray]")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).stroke));
  expect(cvdStrokes).toEqual(strokes);
  await setTheme(page, { cvd: false });
});

test("attribution logo renders in light theme too; light delta text is token-colored", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockFundedHome(page);
  await setTheme(page, { mode: "light", cvd: false });
  await page.goto("/home");

  await expect(page.getByRole("group", { name: /Portfolio value/ })).toBeVisible();
  await expect(page.locator("a[href*='tradingview.com']")).toBeVisible();

  const positive = await tokenColor(page, "text-positive");
  const gainColor = await page
    .getByText("▲ +$1.27 (+4.23%)")
    .evaluate((el) => getComputedStyle(el).color);
  expect(gainColor).toBe(positive);

  const axe = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"]) // OKLCH tokens mis-parse in axe (module 02 note); scripts/contrast.ts is the authority
    .analyze();
  expect(axe.violations).toEqual([]);
  await setTheme(page, { mode: "dark" });
});

test("asset detail: disclosure pinned above actions on equities, absent on SOL; sell + buy-more present", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockFundedHome(page);
  await page.goto("/home");

  await page.getByRole("button", { name: /SPYx, S&P 500/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const disclosure = sheet.getByText(/Issuer: Backed\.$/);
  await expect(disclosure).toBeVisible();
  await expect(sheet.getByText("It is not a share")).toBeVisible();
  // Pinned ABOVE the actions: the disclosure precedes Buy more in the DOM.
  const order = await sheet.evaluate((el) => {
    const text = el.querySelector("p.border-t");
    const button = [...el.querySelectorAll("button, a")].find((b) =>
      b.textContent?.includes("Buy more"),
    );
    if (!text || !button) return -1;
    return text.compareDocumentPosition(button);
  });
  expect(order & 4).toBeTruthy(); // DOCUMENT_POSITION_FOLLOWING
  await expect(sheet.getByRole("button", { name: "Sell" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Buy more" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /SOL, Solana/ }).click();
  const solSheet = page.getByRole("dialog");
  await expect(solSheet).toBeVisible();
  await expect(solSheet.getByText("Issuer: Backed")).toHaveCount(0);
});

test("buy-more prefills the intent bar on /agents", async ({ context, page }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockFundedHome(page);
  await page.goto("/home");

  await page.getByRole("button", { name: /SPYx, S&P 500/ }).click();
  await page.getByRole("button", { name: "Buy more" }).click();
  await page.waitForURL("**/agents?prefill=*");
  await expect(page.getByRole("textbox")).toHaveValue(
    "Buy $25 of SPYx every week",
  );
});

test("empty portfolio (REAL routes): etching + PROPOSED copy + one CTA; axe clean", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  // C1/sweep stay mocked (no live Particle in CI); portfolio.* runs REAL.
  await mockTrpc(page, {
    "account.summary": () => SUMMARY,
    "sweep.preview": () => EMPTY_PREVIEW,
  });
  await page.goto("/home");

  await expect(page.getByText("Your first plan funds this page.")).toBeVisible();
  const cta = page.getByRole("link", { name: "Set up a plan" });
  await expect(cta).toBeVisible();

  // Nothing chart/feed-shaped renders when empty (tab budget + calm).
  await expect(page.getByRole("group", { name: /Portfolio value/ })).toHaveCount(0);
  await expect(page.getByText("See all")).toHaveCount(0);

  const axe = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"]) // OKLCH tokens mis-parse in axe (module 02 note); scripts/contrast.ts is the authority
    .analyze();
  expect(axe.violations).toEqual([]);

  await cta.click();
  await page.waitForURL("**/agents");
});

test("seeded chart + mini-feed against the REAL routes", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  const { jobId } = await seedPlanWithJob(user);

  // A clean SOL buy (fill present → attributed) whose receipt feeds the
  // mini-feed and whose ledger position renders a real holding row.
  await seedExecution(jobId, {
    status: "finished",
    receiptText:
      "Bought $15.00 of SOL · funded from Base · fees $0.05 (gas $0.02, service $0.02, LP $0.01) · view onchain",
    uaTxId: "e2ehome1234567890",
    feesJson: { gas: 0.02, service: 0.02, lp: 0.01, total: 0.05 },
    quoteJson: { fill: { assetId: "sol", usd: 15, qty: 0.1 } },
    createdAt: new Date(Date.now() - 3_600_000),
  });
  const hourMs = 3_600_000;
  const top = Math.floor(Date.now() / hourMs) * hourMs;
  for (const [i, totalUsd] of [14.2, 14.6, 14.9].entries()) {
    await seedSnapshot(user, {
      totalUsd,
      perAsset: { sol: { qty: 0.1, markUsd: totalUsd * 10, valueUsd: totalUsd } },
      at: new Date(top - (3 - i) * hourMs),
    });
  }

  await mockTrpc(page, {
    "account.summary": () => SUMMARY,
    "sweep.preview": () => EMPTY_PREVIEW,
  });
  await page.goto("/home");

  // The real holdings pipeline states the ledger SOL position.
  await expect(page.getByRole("button", { name: /SOL, Solana/ })).toBeVisible();
  // The chart aggregates the seeded snapshots (real portfolio.chart).
  await expect(page.getByRole("group", { name: /Portfolio value/ })).toBeVisible();
  // Sparkline exists (3 seeded points ≥ 2).
  await expect(page.locator("polyline").first()).toBeVisible();

  // Range switch re-queries without breaking the shape (the input is
  // sr-only inside its pill label — click the label, the browser checks it).
  await page.getByText("1W", { exact: true }).click();
  await expect(page.getByRole("group", { name: /Portfolio value/ })).toBeVisible();

  // Mini-feed: the stored sentence renders through module 11's row.
  await expect(page.getByText(/Bought \$15\.00 of SOL/)).toBeVisible();
  await page.getByRole("link", { name: "See all" }).click();
  await page.waitForURL("**/activity");
});
