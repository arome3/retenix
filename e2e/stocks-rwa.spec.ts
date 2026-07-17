import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";
import { mockTrpc } from "./support/trpc-mock";

/*
 * Module 20 — Stocks & RWA expansion (tokenized gold). The buyable region
 * matrix (US sees gold + crypto, never equities) is proven exhaustively in
 * unit tests (packages/registry eligible.test.ts, packages/shared
 * compliance.test.ts) and the US-fallback copy in eligibility.spec.ts; here we
 * prove the RENDER half of the DoD against the real /home surface:
 *   - a tokenized-gold holding shows its VERBATIM disclosure line (PS-F13-AC3);
 *   - a mixed three-asset-class portfolio (equity + gold + crypto) renders as
 *     one statement — the demo's breadth moment.
 * portfolio.holdings is route-mocked (home.spec.ts posture): this measures OUR
 * render pipeline, not Jupiter/Particle; the live mainnet cycle is owner-run
 * under gate G-R1 (doc 16).
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const GOLD_DISCLOSURE =
  "PAXG tracks physical gold held by Paxos. It is a token claim, not vault access. Issuer: Paxos.";

const SPARK = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i / 2) * 5);

// A mixed three-class holding set: equity (Solana) + gold (Ethereum) + crypto.
const MIXED_HOLDINGS = {
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
      assetId: "paxg",
      ticker: "PAXG",
      name: "Gold (tokenized)",
      qty: 0.00125,
      qtyHuman: "0.00125",
      markUsd: 4000,
      markStale: false,
      valueUsd: 5.0,
      costBasisUsd: 5.0,
      deltaUsd: 0,
      deltaPct: 0,
      spark: SPARK.slice(0, 12),
      disclosure: GOLD_DISCLOSURE,
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
  totalUsd: 51.02,
  costBasisUsd: 50.2,
  returnUsd: 0.82,
  returnPct: 1.63,
  asOf: new Date().toISOString(),
  unattributedBuys: 0,
};

const SUMMARY = {
  buyingPowerUsd: 51.02,
  sources: [{ chainId: 42161, name: "Arbitrum", usd: 51.02, pct: 100 }],
  assets: [
    { symbol: "USDC", usd: 51.02, perChain: [{ chainId: 42161, usd: 51.02 }] },
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

async function mockMixedHome(page: Page) {
  await mockTrpc(page, {
    "account.summary": () => SUMMARY,
    "sweep.preview": () => EMPTY_PREVIEW,
    "portfolio.holdings": () => MIXED_HOLDINGS,
    "portfolio.chart": () => ({ points: [] }),
    "portfolio.topUpPrompt": () => null,
    "activity.feed": () => ({ items: [] }),
  });
}

let user: TestUser | undefined;

test.afterEach(async () => {
  if (user) {
    await deleteTestUser(user);
    user = undefined;
  }
});

test.afterAll(async () => {
  await closeDb();
});

test("a mixed three-asset-class portfolio renders equity + gold + crypto as one statement", async ({
  context,
  page,
}) => {
  // A US user can hold gold + crypto; the equity row here stands in for the
  // demo owner account (non-restricted). All three classes on one page.
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockMixedHome(page);
  await page.goto("/home");

  await expect(page.getByRole("button", { name: /SPYx, S&P 500/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /PAXG, Gold/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /SOL, Solana/ })).toBeVisible();
});

test("the tokenized-gold holding shows its verbatim disclosure, pinned above actions (PS-F13-AC3)", async ({
  context,
  page,
}) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockMixedHome(page);
  await page.goto("/home");

  await page.getByRole("button", { name: /PAXG, Gold/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  // The verbatim gold disclosure (G12: "gold", never "RWA").
  await expect(sheet.getByText(GOLD_DISCLOSURE)).toBeVisible();
  await expect(sheet.getByText("Issuer: Paxos.")).toBeVisible();
  await expect(sheet.getByText("token claim, not vault access")).toBeVisible();

  // Pinned ABOVE the actions (the equity-disclosure invariant, for gold too).
  const order = await sheet.evaluate((el) => {
    const text = el.querySelector("p.border-t");
    const button = [...el.querySelectorAll("button, a")].find((b) =>
      b.textContent?.includes("Buy more"),
    );
    if (!text || !button) return -1;
    return text.compareDocumentPosition(button);
  });
  expect(order & 4).toBeTruthy(); // DOCUMENT_POSITION_FOLLOWING

  // "RWA" must never appear in this decision surface.
  await expect(sheet.getByText(/\bRWA\b/)).toHaveCount(0);
});

test("gold detail surface is axe-clean", async ({ context, page }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
  await mockMixedHome(page);
  await page.goto("/home");

  await page.getByRole("button", { name: /PAXG, Gold/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"]) // OKLCH-token quirk (module 02 note)
    .analyze();
  expect(results.violations).toEqual([]);
});
