import { expect, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  setRegion,
  signIn,
  type TestUser,
} from "./support/session";

/*
 * The session, from the outside: it survives a refresh, sign-out ends it, and a
 * cookie that disagrees with the database loses to the database.
 */
test.afterAll(closeDb);

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("US");
  await signIn(context, user, "US");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});

test("survives a page refresh", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
});

test("sign out clears both cookies and closes the app", async ({ page, context }) => {
  await page.goto("/profile");
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });

  const names = (await context.cookies()).map((c) => c.name);
  expect(names).not.toContain("retenix_session");
  expect(names).not.toContain("retenix_gate");

  // And the shell is closed behind us.
  await page.goto("/home");
  await expect(page).toHaveURL(/\/welcome$/);
});

test("the database, not the cookie, decides whether the gate has run", async ({
  page,
}) => {
  await page.goto("/home");
  await expect(page).toHaveURL(/\/home$/);

  // The cookie still claims a region; the row no longer has one.
  await setRegion(user, "");
  await page.goto("/home");
  await expect(page).toHaveURL(/\/eligibility$/);
});

test("a session whose user is gone is ended, not bounced forever", async ({ page }) => {
  await deleteTestUser(user);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/welcome$/);

  const names = (await page.context().cookies()).map((c) => c.name);
  expect(names).not.toContain("retenix_session");

  // afterEach deletes again; make that a no-op rather than a failure.
  user = await createTestUser("US");
});
