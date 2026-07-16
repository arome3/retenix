import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";

// axe can't read this design system's OKLCH colors (contrast is proven by
// scripts/contrast.ts) — every other rule runs.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const axe = (page: Page) =>
  new AxeBuilder({ page }).withTags(WCAG_TAGS).disableRules(["color-contrast"]);

// S3 is a decision surface — no banned vocabulary (doc 01 G12), except the
// sanctioned "enforced on-chain" trust-proof phrase in the Can-never panel.
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

test.afterAll(closeDb);

test.describe("S3 Agents (doc 10)", () => {
  let user: TestUser;

  test.beforeEach(async ({ context }) => {
    user = await createTestUser("DE");
    await signIn(context, user, "DE");
  });
  test.afterEach(async () => {
    if (user) await deleteTestUser(user);
  });

  test("renders the three staff stacks with empty states + the intent bar", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();
    // Three stacks by agent.
    await expect(page.getByRole("region", { name: "Broker agents" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Guardian agents" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Continuity agents" })).toBeVisible();
    // C5 intent bar fixed at the bottom.
    await expect(
      page.getByLabel("Describe an agent in your own words"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Draft it" })).toBeVisible();
  });

  test("the intent bar declines gracefully when drafting is unavailable", async ({
    page,
  }) => {
    // With a placeholder ANTHROPIC_API_KEY the route returns the unavailable
    // decline — escalation over a stack trace (doc 09). With a real key this
    // instead renders draft cards; either way the surface never breaks.
    await page.goto("/agents");
    await page
      .getByLabel("Describe an agent in your own words")
      .fill("Invest $25 every week into SPYx and SOL, stop if I'm down 15%.");
    await page.getByRole("button", { name: "Draft it" }).click();

    // Either draft cards (real key) or a decline (placeholder) — both are valid,
    // neither is an error boundary.
    const draftReview = page.getByTestId("draft-review");
    const declineOrDraft = page
      .getByText(/Here's what I understood|didn't want to guess|build it by hand/i)
      .first();
    await expect(declineOrDraft.or(draftReview)).toBeVisible({ timeout: 20_000 });

    // No stack trace / Next error overlay leaked to the user.
    await expect(page.getByText(/unhandled|stack trace|TRPCError/i)).toHaveCount(0);
  });

  test("beat 3: a parsed draft renders three cards with the confidence line + Can-never panels", async ({
    page,
  }) => {
    // The live model is a manual gate (doc 09); here we intercept intent.parse
    // to prove the C5→C3 rendering of a three-section draft (the parse logic
    // itself is unit-tested). This is the demo beat-3 shape: one utterance →
    // three cards.
    await page.route("**/api/trpc/intent.parse**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: {
              ok: true,
              draftId: "00000000-0000-0000-0000-000000000001",
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
                legacy: { beneficiaryEmail: "ada@example.com", inactivityDays: 180 },
              },
            },
          },
        }),
      });
    });

    await page.goto("/agents");
    await page
      .getByLabel("Describe an agent in your own words")
      .fill("Invest $25 a week — mostly S&P, some Tesla. Stop if I drop 15%.");
    await page.getByRole("button", { name: "Draft it" }).click();

    // The fixed confidence line.
    await expect(
      page.getByText("Here's what I understood — check the numbers"),
    ).toBeVisible();
    // Three draft cards.
    await expect(page.getByRole("article", { name: /broker policy — Draft/i })).toBeVisible();
    await expect(page.getByRole("article", { name: /guardian policy — Draft/i })).toBeVisible();
    await expect(page.getByRole("article", { name: /legacy policy — Draft/i })).toBeVisible();
    // Plain terms rendered from the draft, not the utterance.
    await expect(page.getByText("$25.00 every week")).toBeVisible();
    await expect(page.getByText("15% down")).toBeVisible();
    await expect(page.getByText("ada@example.com")).toBeVisible();
    // The "Can never" trust-proof phrase (sanctioned exception) — one per card.
    await expect(page.getByText("enforced on-chain").first()).toBeVisible();
    // Advice footer on the model-proposed basket (PS-10.7).
    await expect(page.getByText(/not investment advice/i)).toBeVisible();
    // Confirm (never "Sign"), and Discard leaves the flow.
    await expect(page.getByRole("button", { name: "Proceed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
  });

  test("S3 carries no banned vocabulary and is axe-clean", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();

    const body = (await page.locator("main").innerText()).toLowerCase();
    for (const re of BANNED) {
      expect(body, `banned vocabulary ${re}`).not.toMatch(re);
    }
    // The sanctioned trust-proof phrase is absent until a card exists, so an
    // empty roster simply has none — nothing to allowlist here.

    const results = await axe(page).analyze();
    expect(results.violations).toEqual([]);
  });
});
