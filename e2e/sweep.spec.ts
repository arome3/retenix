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
 * The dust-sweep prompt + confirmation flow (doc 06). PS-F2-AC2's UI half:
 * exactly ONE ConfirmSheet interaction for the whole batch. The server half
 * (exactly one sweep.receipt row, per-leg detail, partial failure) is proven
 * DB-backed in apps/web/server/routers/sweep.test.ts — a real end-to-end
 * sweep needs a live Magic session + funded dust and is an owner-run item
 * (doc 16 runbook; seed script packages/ua/scripts/seed-dust.ts).
 *
 * Magic cannot sign in a minted-session browser, so after the single confirm
 * the flow lands in the honest failed state — which is itself asserted: money
 * copy stays calm and no second confirmation is ever requested.
 */

// Demo beat 2's shape: $23.11 across 5 places.
const PREVIEW = {
  totalUsd: 23.11,
  items: [
    { chainId: 1, token: "0xaaa1", symbol: "LINK", usd: 6.11 },
    { chainId: 8453, token: "0xaaa2", symbol: "DEGEN", usd: 5 },
    { chainId: 42161, token: "0xaaa3", symbol: "ARB", usd: 4 },
    { chainId: 56, token: "0xaaa4", symbol: "CAKE", usd: 4 },
    { chainId: 101, token: "BonkMint11111111111111111111111111111111111", symbol: "BONK", usd: 4 },
  ],
  skipped: [],
  fees: { gas: 0.03, service: 0.02, lp: 0.01, total: 0.06 },
  hasSwept: false,
  dismissed: false,
};

const SUMMARY = {
  buyingPowerUsd: 212.4,
  sources: [{ chainId: 8453, name: "Base", usd: 212.4, pct: 100 }],
  assets: [{ symbol: "USDC", usd: 212.4, perChain: [{ chainId: 8453, usd: 212.4 }] }],
  asOf: new Date().toISOString(),
};

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

test("the prompt card renders the canonical copy with live numbers", async ({
  page,
}) => {
  await mockTrpc(page, {
    ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
    "sweep.preview": () => PREVIEW,
  });
  await page.goto("/home");

  const card = page.getByRole("region", { name: "Found money" });
  await expect(card).toBeVisible();
  // CONFLICTS #9, decision-surface wording, verbatim — amount/count interpolated.
  await expect(card).toContainText(
    "We found $23.11 in 5 places. Add it to your buying power?",
  );
  await expect(card.getByRole("button", { name: "One tap" })).toBeVisible();
  // Chain names never appear on the decision surface.
  await expect(card).not.toContainText("Ethereum");
  await expect(card).not.toContainText("Solana");
});

test("PS-F2-AC2 (UI half): ONE confirmation drives the whole batch — no second ask", async ({
  page,
}) => {
  await mockTrpc(page, {
    ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
    "sweep.preview": () => PREVIEW,
  });
  await page.goto("/home");

  await page.getByRole("button", { name: "One tap" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Add $23.11 to your buying power?");
  // Cost preview: fees as ONE number, expandable.
  await expect(sheet).toContainText("fees");
  await expect(sheet).toContainText("~$0.06");

  const confirm = sheet.getByRole("button", { name: "Confirm" });
  await expect(confirm).toHaveCount(1); // exactly one confirmation affordance
  await confirm.click();

  // The single tap starts the batch — headless from here on. Without a live
  // Magic session the envelope signing fails, so the flow lands in the honest
  // failed state: still the SAME sheet (no second dialog, no second ask),
  // calm money copy, and the single Confirm now reads as the retry affordance.
  await expect(sheet).toContainText("That didn't complete", { timeout: 30_000 });
  await expect(sheet).toContainText("Your money only moves when a step succeeds");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(sheet.getByRole("button", { name: "Confirm" })).toHaveCount(1);
});

test("dismissal is remembered and silence does nothing", async ({ page }) => {
  let dismissed = false;
  await mockTrpc(page, {
    ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
    "sweep.preview": () => ({ ...PREVIEW, dismissed }),
    "sweep.dismiss": () => {
      dismissed = true;
      return { dismissed: true };
    },
  });
  await page.goto("/home");

  const card = page.getByRole("region", { name: "Found money" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toBeHidden();

  // A reload consults the server-remembered dismissal — the offer stays away.
  await page.goto("/home");
  await expect(page.getByRole("region", { name: "Found money" })).toBeHidden();
});

test("no prompt below the $1 threshold or after a sweep", async ({ page }) => {
  await mockTrpc(page, {
    ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
    "sweep.preview": () => ({ ...PREVIEW, totalUsd: 0.8 }),
  });
  await page.goto("/home");
  await expect(page.getByText("Buying power").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Found money" })).toBeHidden();

  await mockTrpc(page, {
    ...emptyPortfolioMocks, // Home also queries portfolio.* (doc 12) — same batch
      "account.summary": () => SUMMARY,
    "sweep.preview": () => ({ ...PREVIEW, hasSwept: true }),
  });
  await page.goto("/home");
  await expect(page.getByText("Buying power").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Found money" })).toBeHidden();
});
