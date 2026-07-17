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
 * /send + /send/withdraw (doc 15). Magic cannot sign in a minted-session
 * headless browser (module 02's documented limit) — the module-06/13 posture:
 * assert the surfaces and the honest failure states; the resolution/receipt
 * SEMANTICS are DB-proven in send.test.ts and the live $2 sends are owner-run.
 *
 * The load-bearing scans: NO network name anywhere on /send; the withdraw
 * step-3 exception framing ("Where should it arrive?" — a property of the
 * destination); NO default-selected network, ever.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// The six network names (G3) — banned from /send entirely; on /send/withdraw
// they may appear ONLY as the step-3 destination options + the C6 arrival line.
const NETWORK_NAMES = ["Ethereum", "BSC", "Base", "X Layer", "Arbitrum", "Solana"];

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

const sendMocks = (over: Record<string, () => unknown> = {}) => ({
  ...emptyPortfolioMocks,
  "send.resolve": () => ({ status: "registered", display: "a•••@example.com" }),
  ...over,
});

test("send form: to/amount/confirm, live preview, no network named anywhere", async ({
  page,
}) => {
  await mockTrpc(page, sendMocks());
  await page.goto("/send");

  await expect(page.getByRole("heading", { name: "Send", exact: true })).toBeVisible();

  const to = page.getByLabel("To", { exact: true });
  await to.fill("ana@example.com");
  // the input itself is NEVER truncated (DS-9.3)
  await expect(to).toHaveValue("ana@example.com");
  await expect(page.getByText("they're on Retenix")).toBeVisible();

  await page.getByLabel("Amount", { exact: true }).fill("20");
  const review = page.getByRole("button", { name: "Review" });
  await expect(review).toBeEnabled();
  await review.click();

  // C6: the sentence names the masked recipient; Confirm never "Sign"
  await expect(
    page.getByRole("heading", { name: "Send $20.00 to a•••@example.com" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sign/ })).toHaveCount(0);

  // the whole screen is network-free (G3 — withdraw is the only exception)
  const body = (await page.locator("body").textContent()) ?? "";
  for (const name of NETWORK_NAMES) {
    expect(body, `network name "${name}" leaked into /send`).not.toContain(name);
  }

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test("send: honest failure state when signing can't complete headless", async ({
  page,
}) => {
  // authorize succeeds server-side; the browser leg then fails (no Magic in
  // headless) — the sheet must show the failure, never a fake receipt.
  await mockTrpc(page, sendMocks());
  await page.goto("/send");
  await page.getByLabel("To", { exact: true }).fill("ana@example.com");
  await page.getByLabel("Amount", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  // the run ends in an error message inside the sheet (authorize envelope
  // signing needs Magic → fails immediately and honestly)
  await expect(page.locator(".text-negative").first()).toBeVisible({
    timeout: 15_000,
  });
  const body = (await page.locator("body").textContent()) ?? "";
  expect(body).not.toContain("view onchain"); // no receipt was minted
});

test("send: unregistered email pre-flags the invite path", async ({ page }) => {
  await mockTrpc(
    page,
    sendMocks({
      "send.resolve": () => ({ status: "unregistered", display: "s•••@example.com" }),
    }),
  );
  await page.goto("/send");
  await page.getByLabel("To", { exact: true }).fill("stranger@example.com");
  await expect(
    page.getByText("They don't have Retenix yet — we'll invite them instead of sending."),
  ).toBeVisible();
});

test("send: ENS miss and bad checksum render honest statuses", async ({ page }) => {
  await mockTrpc(
    page,
    sendMocks({ "send.resolve": () => ({ status: "not-found", display: "nobody.eth" }) }),
  );
  await page.goto("/send");
  await page.getByLabel("To", { exact: true }).fill("nobody.eth");
  await expect(page.getByText("name not found")).toBeVisible();

  await mockTrpc(
    page,
    sendMocks({ "send.resolve": () => ({ status: "invalid", display: "0x123" }) }),
  );
  await page.getByLabel("To", { exact: true }).fill("0x" + "12".repeat(20));
  await expect(page.getByText("that doesn't look right")).toBeVisible();
});

test("withdraw: three steps; the network choice is framed as the destination's and NEVER default-selected", async ({
  page,
}) => {
  await mockTrpc(page, sendMocks());
  await page.goto("/send/withdraw");

  await expect(page.getByRole("heading", { name: "Withdraw" })).toBeVisible();

  // Step 1 — asset + amount. No network names visible yet.
  const step1Body = (await page.locator("body").textContent()) ?? "";
  for (const name of NETWORK_NAMES) {
    expect(step1Body, `network "${name}" leaked into withdraw step 1`).not.toContain(name);
  }
  await page.getByText("USDC", { exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — address (never truncated in the input).
  const addr = "0x" + "ab".repeat(20);
  await page.getByLabel("Destination address", { exact: true }).fill(addr);
  await expect(page.getByLabel("Destination address", { exact: true })).toHaveValue(addr);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3 — THE exception surface, framed as a property of the destination.
  await expect(page.getByText("Where should it arrive?")).toBeVisible();
  await expect(
    page.getByText("Ask the receiving account if you're unsure."),
  ).toBeVisible();

  // USDC exists on five networks; NONE is pre-selected (the law).
  const radios = page.locator('input[name="withdraw-destination"]');
  await expect(radios).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(radios.nth(i)).not.toBeChecked();
  }
  // Review stays disabled until the user explicitly chooses.
  await expect(page.getByRole("button", { name: "Review" })).toBeDisabled();

  await page.getByText("Arbitrum", { exact: true }).click();
  await page.getByRole("button", { name: "Review" }).click();

  // C6 carries the explicit arrival line.
  await expect(
    page.getByText("Arrives on Arbitrum — make sure the address expects it there."),
  ).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test("withdraw: single-network assets still require the explicit tap", async ({
  page,
}) => {
  await mockTrpc(page, sendMocks());
  await page.goto("/send/withdraw");
  await page.getByText("SOL", { exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByLabel("Destination address")
    .fill("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  await page.getByRole("button", { name: "Continue" }).click();

  const radios = page.locator('input[name="withdraw-destination"]');
  await expect(radios).toHaveCount(1);
  await expect(radios.first()).not.toBeChecked(); // never silently selected
  await expect(page.getByRole("button", { name: "Review" })).toBeDisabled();
});

test("withdraw: address family must match the chosen destination", async ({ page }) => {
  await mockTrpc(page, sendMocks());
  await page.goto("/send/withdraw");
  await page.getByText("USDC", { exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Continue" }).click();
  // an EVM address…
  await page.getByLabel("Destination address", { exact: true }).fill("0x" + "ab".repeat(20));
  await page.getByRole("button", { name: "Continue" }).click();
  // …with the Solana destination → the mismatch is called out pre-confirm
  await page.getByText("Solana", { exact: true }).click();
  await expect(
    page.getByText("that address doesn't match this destination"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review" })).toBeDisabled();
});

test("Home overflow: one ⋯ trigger; Send/Withdraw join tab order only when open", async ({
  page,
}) => {
  await mockTrpc(page, emptyPortfolioMocks);
  await page.goto("/home");

  const trigger = page.getByRole("button", { name: "More", exact: true });
  await expect(trigger).toBeVisible();
  // closed → no Send/Withdraw links anywhere in the document
  await expect(page.getByRole("link", { name: "Send", exact: true })).toHaveCount(0);

  await trigger.click();
  await page.getByRole("link", { name: "Send", exact: true }).click();
  await page.waitForURL("**/send");
  await expect(page.getByRole("heading", { name: "Send", exact: true })).toBeVisible();
});
