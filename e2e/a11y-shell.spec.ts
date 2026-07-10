import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";

// Doc 01 definition of done: axe-core clean on the shell; keyboard tab order
// walks Home→Activity→Agents→Profile. Run with the web app serving on
// APP_BASE_URL (default http://localhost:3000): `pnpm --filter web dev`.
//
// The shell became authed in module 02, so these specs sign in first.

const SHELL_ROUTES = ["/home", "/activity", "/agents", "/profile"];

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("US");
  await signIn(context, user, "US");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

// The compliance target is WCAG 2.2 AA (doc 01 §Accessibility baseline);
// axe "best-practice" rules (e.g. page-has-heading-one on the not-yet-built
// stub pages owned by docs 10–15) are outside the baseline.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const route of SHELL_ROUTES) {
  test(`axe: zero violations on ${route}`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test("keyboard walk: tab order Home→Activity→Agents→Profile", async ({
  page,
}) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // first Tab lands on the skip link, then the four tabs in order
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Skip to content");
  for (const label of ["Home", "Activity", "Agents", "Profile"]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText(label);
  }

  // the current tab exposes aria-current="page"
  await expect(
    page.locator('a[aria-current="page"]', { hasText: "Home" }),
  ).toHaveCount(1);

  // focus ring: the focused element carries the 2px outline from globals.css
  const outline = await page
    .locator(":focus")
    .evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(outline).toBe("2px");
});

test("axe: zero violations on /dev/tokens (light + dark)", async ({ page }) => {
  await page.goto("/dev/tokens");
  await page.waitForLoadState("networkidle");
  for (const mode of ["Light", "Dark"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(250);
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      // contrast is verified analytically over the OKLCH tokens by
      // scripts/contrast.ts; the dev sheet intentionally displays the
      // documented large-text-only pairs at demo sizes
      .disableRules(["color-contrast"])
      .analyze();
    expect(results.violations).toEqual([]);
  }
});
