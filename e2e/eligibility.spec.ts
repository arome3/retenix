import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  readRegion,
  signIn,
  type TestUser,
} from "./support/session";

// axe cannot read this design system's OKLCH colors (contrast is verified
// analytically by scripts/contrast.ts) — every other rule runs.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const axe = (page: Page) =>
  new AxeBuilder({ page }).withTags(WCAG_TAGS).disableRules(["color-contrast"]);

/*
 * C12 EligibilityGate (doc 04). The deep-link-proof matrix (PS-F1-AC4) and the
 * gate flow, observed from outside the app. Region-less test users are mid-gate
 * (users.region is "" until finalization); a "US"/"DE" user has passed it.
 */

// Decision-surface banned vocabulary (doc 01 G12) — same list the S1 spec uses.
const BANNED = [
  /\bseed[\s-]?phrases?\b/i,
  /\bwallets?\b/i,
  /\bgas\b/i,
  /\bchains?\b/i,
  /\bnetworks?\b/i,
  /\bbridg(?:e|es|ed|ing)\b/i,
  /\bslippage\b/i,
  /\bsmart[\s-]contracts?\b/i,
  /\bdelegat(?:e|es|ed|ing|ion|ions)\b/i,
  // doc 20 G12: the fallback offers "tokenized gold", never "RWA".
  /\brwa\b/i,
  /\breal[\s-]world\s+assets?\b/i,
];

// Verbatim correct-answer substrings (doc 04). Clicking the option text forwards
// to its radio (a <button> is labelable) and advances.
const CORRECT = [
  "token that tracks the price",
  "like any investment, and it also depends on the issuer",
  "Around the clock",
  // Q4 (doc 18 F11) — the daily-reset decay question that unlocks leveraged
  // assets. Deliberately worded without "leverage" (G12 reserves that word
  // for the F12 compliance surface), so the banned-vocab walk below stays
  // clean through this screen too.
  "it resets daily",
];

test.afterAll(closeDb);

async function pickRegion(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Region" }).click();
  await page.getByPlaceholder("Search countries").fill(name);
  await page.getByRole("option", { name, exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
}

async function answerQuiz(page: Page): Promise<void> {
  await page.getByText(CORRECT[0]).click();
  await expect(page).toHaveURL(/\/eligibility\/quiz\/2$/);
  await page.getByText(CORRECT[1]).click();
  await expect(page).toHaveURL(/\/eligibility\/quiz\/3$/);
  await page.getByText(CORRECT[2]).click();
  await expect(page).toHaveURL(/\/eligibility\/quiz\/4$/);
  await page.getByText(CORRECT[3]).click();
  await expect(page).toHaveURL(/\/eligibility\/identity$/);
}

async function fillIdentity(page: Page): Promise<void> {
  await page.getByLabel("Full name").fill("Ada Lovelace");
  await page.getByLabel("Date of birth").fill("1990-01-01");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/eligibility\/risk$/);
}

async function confirmRisk(page: Page): Promise<void> {
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/ready$/);
}

test.describe("PS-F1-AC4 · the gate cannot be skipped by deep link", () => {
  let user: TestUser;
  test.beforeEach(async ({ context }) => {
    user = await createTestUser("");
    await signIn(context, user, "");
  });
  test.afterEach(async () => {
    await deleteTestUser(user);
  });

  test("every app route redirects a region-less session to the gate", async ({
    page,
  }) => {
    for (const route of [
      "/home",
      "/agents",
      "/legacy",
      "/kill",
      "/profile",
      "/activity",
    ]) {
      await page.goto(route);
      await expect(page, `${route} must be gated`).toHaveURL(
        /\/eligibility\/region$/,
      );
    }
  });

  test("raw tRPC account.summary is refused (403) until the gate passes", async ({
    page,
  }) => {
    const res = await page.request.get("/api/trpc/account.summary");
    expect(res.status()).toBe(403);
  });

  test("mid-gate (region picked, not finalized), /home still bounces", async ({
    page,
  }) => {
    await page.goto("/eligibility/region");
    await pickRegion(page, "Germany");
    await expect(page).toHaveURL(/\/eligibility\/quiz\/1$/);

    // The region column is still "" (only the region_set event exists), so a
    // pasted app URL in this state is still gated.
    await page.goto("/home");
    await expect(page).toHaveURL(/\/eligibility\/region$/);
  });

  test("pasting /eligibility/risk with no prior steps cannot finalize", async ({
    page,
  }) => {
    await page.goto("/eligibility/risk");
    // The client guard sends an unqualified visitor back to the start; even if it
    // did not, acknowledgeRisk asserts the prior events server-side.
    await expect(page).toHaveURL(/\/eligibility\/region$/);
    expect(await readRegion(user)).toBe("");
  });
});

test.describe("the gate flow (eligible region)", () => {
  let user: TestUser;
  test.beforeEach(async ({ context }) => {
    user = await createTestUser("");
    await signIn(context, user, "");
  });
  test.afterEach(async () => {
    await deleteTestUser(user);
  });

  test("a full walkthrough finalizes the gate and unlocks the app", async ({
    page,
  }) => {
    await page.goto("/eligibility/region");
    await pickRegion(page, "Germany");
    await answerQuiz(page);
    await fillIdentity(page);
    await confirmRisk(page);

    await expect(
      page.getByRole("heading", { name: "Your account is ready" }),
    ).toBeVisible();
    expect(await readRegion(user)).toBe("DE");

    // The app is now reachable — the gate no longer bounces.
    await page.goto("/home");
    await expect(page).toHaveURL(/\/home$/);
  });

  test("a wrong answer teaches (amber) and allows a retry", async ({ page }) => {
    await page.goto("/eligibility/region");
    await pickRegion(page, "Germany");
    await expect(page).toHaveURL(/\/eligibility\/quiz\/1$/);

    // Pick the wrong option: the explanation shows and we stay on question 1.
    await page
      .getByText("holding TSLAx is the same as owning Tesla stock")
      .click();
    await expect(page).toHaveURL(/\/eligibility\/quiz\/1$/);
    await expect(
      page.getByText("TSLAx is a token that tracks Tesla's price"),
    ).toBeVisible();

    // The correct answer still advances.
    await page.getByText(CORRECT[0]).click();
    await expect(page).toHaveURL(/\/eligibility\/quiz\/2$/);
  });
});

test.describe("PS-F1.3 · restricted region — a hard block that is not a wall", () => {
  let user: TestUser;
  test.beforeEach(async ({ context }) => {
    user = await createTestUser("");
    await signIn(context, user, "");
  });
  test.afterEach(async () => {
    await deleteTestUser(user);
  });

  test("a restricted pick shows the block, then continues into the same flow", async ({
    page,
  }) => {
    await page.goto("/eligibility/region");
    await pickRegion(page, "United States");

    await expect(
      page.getByRole("heading", {
        name: "Tokenized stocks aren't available in your region",
      }),
    ).toBeVisible();
    // doc 20: the US fallback now offers crypto + gold (not crypto-only).
    await expect(
      page.getByText("crypto basket — SOL and ETH — plus tokenized gold"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();
    await answerQuiz(page);
    await fillIdentity(page);
    await confirmRisk(page);

    expect(await readRegion(user)).toBe("US");
  });

  test("the back button cannot re-pick a non-restricted region (anti gate-shop)", async ({
    page,
  }) => {
    await page.goto("/eligibility/region");
    await pickRegion(page, "United States");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/eligibility\/quiz\/1$/);

    // Go back and try to switch to Germany — the immutable region refuses.
    await page.goto("/eligibility/region");
    await pickRegion(page, "Germany");
    await answerQuiz(page);
    await fillIdentity(page);
    await confirmRisk(page);

    // Region stayed US: the equity path was never re-entered.
    expect(await readRegion(user)).toBe("US");
  });
});

test.describe("compliance surfaces", () => {
  test("the simulated-identity label is visible on the identity screen", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("");
    try {
      await signIn(context, user, "");
      await page.goto("/eligibility/region");
      await pickRegion(page, "Germany");
      await answerQuiz(page);

      const label = page.getByText(
        "Demo: identity verification is simulated for this hackathon build.",
      );
      await expect(label).toBeVisible();
      await page.screenshot({
        path: "test-results/simulated-identity-label.png",
        fullPage: true,
      });
    } finally {
      await deleteTestUser(user);
    }
  });

  test("no banned vocabulary on any gate screen (G12)", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("");
    try {
      await signIn(context, user, "");

      const assertClean = async (label: string) => {
        const html = await page.content();
        expect(html, `${label} must never contain "seed phrase"`).not.toMatch(
          /seed[\s-]?phrase/i,
        );
        const text = (await page.locator("body").innerText()).replace(
          /\s+/g,
          " ",
        );
        for (const pattern of BANNED) {
          expect(text, `${label} violates ${pattern}`).not.toMatch(pattern);
        }
      };

      await page.goto("/eligibility/region");
      await assertClean("region");
      await pickRegion(page, "Germany");
      await assertClean("quiz/1");
      await page.getByText(CORRECT[0]).click();
      await assertClean("quiz/2");
      await page.getByText(CORRECT[1]).click();
      await assertClean("quiz/3");
      await page.getByText(CORRECT[2]).click();
      await assertClean("quiz/4");
      await page.getByText(CORRECT[3]).click();
      await assertClean("identity");
      await fillIdentity(page);
      await assertClean("risk");
    } finally {
      await deleteTestUser(user);
    }
  });

  test("a restricted hard-block screen is also clean", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("");
    try {
      await signIn(context, user, "");
      await page.goto("/eligibility/region");
      await pickRegion(page, "United States");
      await expect(
        page.getByRole("heading", {
          name: "Tokenized stocks aren't available in your region",
        }),
      ).toBeVisible();
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      for (const pattern of BANNED) {
        expect(text, `hard-block violates ${pattern}`).not.toMatch(pattern);
      }
    } finally {
      await deleteTestUser(user);
    }
  });
});

test.describe("accessibility", () => {
  test("axe: zero violations across the gate screens", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("");
    try {
      await signIn(context, user, "");

      await page.goto("/eligibility/region");
      await page.waitForLoadState("networkidle");
      expect((await axe(page).analyze()).violations, "region").toEqual([]);

      // The searchable combobox open, with an active option.
      await page.getByRole("button", { name: "Region" }).click();
      await page.getByPlaceholder("Search countries").fill("Germany");
      expect((await axe(page).analyze()).violations, "combobox").toEqual([]);
      await page.getByRole("option", { name: "Germany", exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page).toHaveURL(/\/eligibility\/quiz\/1$/);
      await page.waitForLoadState("networkidle");
      expect((await axe(page).analyze()).violations, "quiz").toEqual([]);

      await answerQuiz(page);
      await page.waitForLoadState("networkidle");
      expect((await axe(page).analyze()).violations, "identity").toEqual([]);

      await fillIdentity(page);
      await page.waitForLoadState("networkidle");
      expect((await axe(page).analyze()).violations, "risk").toEqual([]);
    } finally {
      await deleteTestUser(user);
    }
  });
});

test.describe("a finished user cannot re-enter the gate", () => {
  test("a gated (region-set) session on a gate sub-route is forwarded to /ready", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("US");
    try {
      await signIn(context, user, "US");
      for (const route of [
        "/eligibility/region",
        "/eligibility/quiz/1",
        "/eligibility/risk",
      ]) {
        await page.goto(route);
        await expect(page, `${route} should forward a finished user`).toHaveURL(
          /\/ready$/,
        );
      }
    } finally {
      await deleteTestUser(user);
    }
  });
});
