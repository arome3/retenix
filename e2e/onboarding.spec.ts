import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";

/*
 * S1 onboarding (doc 02). The three acceptance criteria that can be observed
 * from outside the app live here:
 *
 *   PS-F1-AC2  zero chain-selection steps anywhere in onboarding
 *   PS-F1-AC3  "seed phrase" appears nowhere
 *   DS-S1      wordmark -> email -> OTP -> gate -> "Your account is ready"
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// G12's decision-surface list (doc 01). "sources" is receipts-only vocabulary,
// so none of it may appear on an onboarding screen either.
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
];

test.afterAll(closeDb);

test.describe("S1 · /welcome", () => {
  test("DS-S1: wordmark, one promise, one email field — and nothing to choose", async ({
    page,
  }) => {
    await page.goto("/welcome");

    await expect(page.getByRole("heading", { name: "Retenix" })).toBeVisible();
    await expect(
      page.getByText("Investing that runs itself, and always answers to you."),
    ).toBeVisible();

    const email = page.getByLabel("Email");
    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute("type", "email");
    // React 19 emits the prop verbatim; HTML attribute names are case-insensitive.
    expect(await email.getAttribute("autocomplete")).toBe("email");

    // Exactly one field: no password, no second factor, no cognitive test (3.3.8).
    await expect(page.locator("input:not([type=hidden])")).toHaveCount(1);
  });

  test("PS-F1-AC2 / G4: no chain selector, and no connect-a-wallet affordance", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await expect(page.locator("select")).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toMatch(/metamask|walletconnect|connect wallet/i);
  });

  test("submitting an email advances to the code screen", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByLabel("Email").fill("e2e@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/otp$/);
  });
});

test.describe("S1 · /otp", () => {
  test("bounces back to welcome when arrived at directly", async ({ page }) => {
    await page.goto("/otp");
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("keeps the wait honest: it says it is waiting, and offers a resend", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await page.getByLabel("Email").fill("e2e@example.com");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("e2e@example.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send another code" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Use a different email" })).toBeVisible();
  });
});

test.describe("S1 · gated screens", () => {
  let user: TestUser;

  test.beforeEach(async ({ context }) => {
    user = await createTestUser("");
    await signIn(context, user, "");
  });
  test.afterEach(async () => {
    await deleteTestUser(user);
  });

  test("a region-less session reaches only the gate", async ({ page }) => {
    await page.goto("/home");
    await expect(page).toHaveURL(/\/eligibility$/);
    await expect(page.getByRole("heading", { name: "One quick check" })).toBeVisible();
  });
});

test.describe("S1 · /ready", () => {
  let user: TestUser;

  test.beforeEach(async ({ context }) => {
    user = await createTestUser("US");
    await signIn(context, user, "US");
  });
  test.afterEach(async () => {
    await deleteTestUser(user);
  });

  test('shows "Your account is ready" with a truncated address and a copy chip', async ({
    page,
  }) => {
    await page.goto("/ready");
    await expect(
      page.getByRole("heading", { name: "Your account is ready" }),
    ).toBeVisible();

    const short = `${user.eoa.slice(0, 6)}…${user.eoa.slice(-4)}`;
    await expect(page.getByText(short, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy your full address" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/home");
  });

  test("the address chip copies the full address, not the truncation", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/ready");
    await page.getByRole("button", { name: "Copy your full address" }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(user.eoa);
  });
});

test.describe("copy canon over rendered HTML", () => {
  test("PS-F1-AC3: no banned vocabulary on any S1 or settings surface", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("US");
    await signIn(context, user, "US");

    // /welcome and /otp are checked without a session, since a finished user is
    // redirected off them.
    const gated = ["/ready", "/profile", "/profile/export"];
    for (const route of gated) {
      await page.goto(route);
      const html = await page.content();
      expect(html, `${route} must never contain "seed phrase"`).not.toMatch(
        /seed[\s-]?phrase/i,
      );
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      for (const pattern of BANNED) {
        expect(text, `${route} violates ${pattern}`).not.toMatch(pattern);
      }
      expect(await page.locator("select").count(), `${route} offers a choice`).toBe(0);
    }

    await deleteTestUser(user);
    await context.clearCookies();

    for (const route of ["/welcome", "/otp"]) {
      await page.goto("/welcome");
      if (route === "/otp") {
        await page.getByLabel("Email").fill("e2e@example.com");
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page).toHaveURL(/\/otp$/);
      }
      const html = await page.content();
      expect(html, `${route} must never contain "seed phrase"`).not.toMatch(
        /seed[\s-]?phrase/i,
      );
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      for (const pattern of BANNED) {
        expect(text, `${route} violates ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

/*
 * axe cannot read this design system's colors. Browsers serialize the OKLCH
 * tokens' computed values as lab(), which axe-core 4.12 mis-parses: on
 * /profile/export it reports the teal button as "#5b5d60 on #28aaaa" (2.33:1)
 * when the real pair is primary-foreground on primary, ~10:1.
 *
 * Contrast is therefore verified analytically over the tokens themselves by
 * scripts/contrast.ts, which asserts exactly this pair (doc 01 step 12, and the
 * same reasoning module 01 recorded on /dev/tokens). Every other axe rule runs.
 */
test.describe("accessibility", () => {
  const axe = (page: Parameters<typeof AxeBuilder>[0]["page"]) =>
    new AxeBuilder({ page }).withTags(WCAG_TAGS).disableRules(["color-contrast"]);

  test("axe: zero violations on the ungated S1 screens", async ({ page }) => {
    for (const route of ["/welcome"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      expect((await axe(page).analyze()).violations, `${route}`).toEqual([]);
    }
  });

  test("axe: zero violations on the gated S1 and settings screens", async ({
    page,
    context,
  }) => {
    const user = await createTestUser("US");
    await signIn(context, user, "US");
    for (const route of ["/ready", "/profile", "/profile/export"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      expect((await axe(page).analyze()).violations, `${route}`).toEqual([]);
    }
    await deleteTestUser(user);
  });
});
