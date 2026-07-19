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
 * Profile assembly + C13 SecurityPage (doc 15). The revoke-all SEMANTICS are
 * DB-proven in security.test.ts; here the surfaces: rows, verbatim copy
 * (PS-4.3 + the TrustFooter badge), the live panel's three states (skeleton
 * is transient; rows / couldn't-check asserted), the typed-word keyboard
 * path, and beat 7 — Profile → Export key (the demo close).
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// PS-4.3 required copy — byte-exact on the page (sanctioned exception phrase).
const PLAIN_CLAIM =
  "Your account is a standard address you can take anywhere. Limits are enforced by the chain, not by us.";
const TRUST_BADGE = "Self-custodial — your keys, your account";

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

const delegationRows = {
  unavailable: false,
  asOf: new Date().toISOString(),
  rows: [
    { chainId: 1, network: "Ethereum", delegated: false },
    { chainId: 56, network: "BSC", delegated: false },
    { chainId: 8453, network: "Base", delegated: false },
    { chainId: 196, network: "X Layer", delegated: false },
    {
      chainId: 42161,
      network: "Arbitrum",
      delegated: true,
      delegate: { kind: "ua", address: "0x" + "1a".repeat(20) },
    },
  ],
};

const securityMocks = (over: Record<string, () => unknown> = {}) => ({
  ...emptyPortfolioMocks,
  "security.delegations": () => delegationRows,
  "security.prepareRevokeAll": () => ({
    needsRevoke: true,
    digest: `0x${"cd".repeat(32)}`,
    nonce: "7",
    revocable: [
      { planId: "p1", kind: "broker" },
      { planId: "p2", kind: "guardian" },
    ],
  }),
  ...over,
});

test("profile: the doc-15 rows in order, the TrustFooter badge verbatim", async ({
  page,
}) => {
  await mockTrpc(page, emptyPortfolioMocks);
  await page.goto("/profile");

  await expect(page.getByText(TRUST_BADGE, { exact: true })).toBeVisible();

  // Row set (Account is display-only; Magic's email can't load headless).
  await expect(page.getByText("Account", { exact: true })).toBeVisible();
  await expect(page.getByText("Security & protection")).toBeVisible();
  await expect(page.getByText("Export your key")).toBeVisible();
  await expect(page.getByText("Accessible colors")).toBeVisible();
  await expect(page.getByText("Add to Home Screen")).toBeVisible();
  await expect(page.getByText("Help", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test("profile: the accessible-colors switch drives the CVD class", async ({ page }) => {
  await mockTrpc(page, emptyPortfolioMocks);
  await page.goto("/profile");

  const toggle = page.getByRole("switch", { name: "Accessible colors" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.locator("html")).toHaveClass(/cvd/);
  await toggle.uncheck();
  await expect(page.locator("html")).not.toHaveClass(/cvd/);
});

test("beat 7 — Profile → Export key opens the C14 flow (the demo close)", async ({
  page,
}) => {
  await mockTrpc(page, emptyPortfolioMocks);
  await page.goto("/profile");
  await page.getByText("Export your key").click();
  await page.waitForURL("**/profile/export");
  // The C14 framing + the one action that opens Magic's user-only modal.
  await expect(page.getByRole("button", { name: "Show my key" })).toBeVisible();
});

test("C13: five blocks — claim verbatim, named programs, live rows, dismiss, audit links", async ({
  page,
}) => {
  await mockTrpc(page, securityMocks());
  await page.goto("/profile/security");

  await expect(
    page.getByRole("heading", { name: "How your money is protected" }),
  ).toBeVisible();
  await expect(page.getByText(PLAIN_CLAIM, { exact: true })).toBeVisible();
  await expect(
    page.getByText("These are the only two programs your account ever delegates to."),
  ).toBeVisible();

  // Named programs: Particle UA (docs link) + RetenixClaim (Arbiscan for the
  // deployed chain; honest not-yet-active for the rest).
  await expect(
    page.getByRole("link", { name: "Read Particle's documentation" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Arbiscan" })).toBeVisible();
  await expect(page.getByText("not yet active on this network")).toHaveCount(4);

  // Live panel rows — the delegated chain names its program; others show —.
  await expect(page.getByText("✓ Universal Account")).toBeVisible();
  await expect(page.getByText("—", { exact: true })).toHaveCount(4);

  // Audit line links both verified programs.
  await expect(page.getByRole("link", { name: "RetenixPolicy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "RetenixClaim", exact: true })).toBeVisible();

  // color-contrast is asserted analytically by scripts/contrast.ts — axe
  // mis-parses the OKLCH tokens (module 02 note).
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("C13: the live panel error state is honest — never a fake ✓", async ({ page }) => {
  await mockTrpc(
    page,
    securityMocks({ "security.delegations": () => ({ unavailable: true }) }),
  );
  await page.goto("/profile/security");
  await expect(page.getByText("couldn't check just now")).toBeVisible();
  await expect(page.getByText("✓ Universal Account")).toHaveCount(0);
});

test("C13: revoke-all is gated by the typed word, keyboard end to end", async ({
  page,
}) => {
  await mockTrpc(page, securityMocks());
  await page.goto("/profile/security");

  // open the sheet from the keyboard
  const dismiss = page.getByRole("button", { name: "Dismiss all staff" });
  await expect(dismiss).toBeEnabled();
  await dismiss.press("Enter"); // keyboard activation, not a pointer click
  await expect(
    page.getByRole("heading", { name: "Dismiss all staff — 2 agents lose authority" }),
  ).toBeVisible();

  // Confirm is locked until the word is typed exactly
  const confirm = page.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  const word = page.getByLabel("Type REVOKE to confirm");
  await word.focus();
  await page.keyboard.type("REVO");
  await expect(confirm).toBeDisabled();
  await page.keyboard.type("KE");
  await expect(confirm).toBeEnabled();

  // Esc disarms (Radix focus trap owns the sheet)
  await page.keyboard.press("Escape");
  await expect(confirm).not.toBeVisible();
});
