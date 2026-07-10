import { expect, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteEventsBySid,
  deleteTestUser,
  readOnboardingEvents,
  readRealOnboardingReady,
  signIn,
} from "./support/session";

/*
 * PS-F1-AC1: email -> account ready in under 60 seconds on a warm path.
 *
 * The measurement is the pair of events rows, not a stopwatch in the test: both
 * carry the server clock, and onboarding.ready records the delta. Magic's OTP
 * cannot be scripted — test mode short-circuits Magic *links* only, never email
 * OTP, so a real code lands in a real inbox — which is why AC1 is asserted over
 * whatever real run the rows recorded, and skipped when there is none.
 *
 * The first test proves the instrumentation itself: both rows land, they pair by
 * sid, and the delta is a server-clock difference. It excludes email delivery,
 * so it is not, and does not claim to be, the AC1 number.
 */
const AC1_BUDGET_MS = 60_000;

test.afterAll(closeDb);

test("instrumentation: onboarding.started and onboarding.ready pair by sid", async ({
  page,
  context,
}) => {
  await page.goto("/welcome");
  await page.getByLabel("Email").fill("warm-path@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/otp$/);

  const sid = await page.evaluate(() =>
    sessionStorage.getItem("retenix:onboarding:sid"),
  );
  expect(sid).toMatch(/^[0-9a-f-]{36}$/);

  // Stand in for the part of the flow Magic owns: a verified session lands.
  const user = await createTestUser("US");
  await signIn(context, user, "US");
  await page.goto("/ready");
  await expect(page.getByRole("heading", { name: "Your account is ready" })).toBeVisible();

  await expect(async () => {
    const rows = await readOnboardingEvents(sid!);
    expect(rows.map((r) => r.type).sort()).toEqual([
      "onboarding.ready",
      "onboarding.started",
    ]);
    const ready = rows.find((r) => r.type === "onboarding.ready")!;
    expect(typeof ready.payload.elapsedMs).toBe("number");
    expect(ready.payload.elapsedMs).toBeGreaterThanOrEqual(0);
  }).toPass({ timeout: 20_000 });

  await deleteEventsBySid(sid!);
  await deleteTestUser(user);
});

test("PS-F1-AC1: the newest real onboarding finished under 60s", async () => {
  // Deliberately not "the newest row": the spec above fabricates one, and a
  // synthetic number reported as the measured warm path would be a lie.
  const ready = await readRealOnboardingReady();

  test.skip(
    !ready,
    "No real onboarding recorded yet. Sign in once with a real email " +
      "(Magic's OTP lands in an inbox and cannot be scripted), then re-run.",
  );

  const elapsedMs = ready!.payload.elapsedMs!;
  console.log(
    `\n  PS-F1-AC1 warm path: ${(elapsedMs / 1000).toFixed(1)}s  (budget 60s)\n`,
  );
  expect(elapsedMs).toBeLessThan(AC1_BUDGET_MS);
});
