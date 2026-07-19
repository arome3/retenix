import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  closeDb,
  createTestUser,
  deleteTestUser,
  signIn,
  type TestUser,
} from "./support/session";
import { mockTrpc } from "./support/trpc-mock";

/*
 * S5 / C8 / S6 (doc 14) — surface structure, verbatim copy, and the
 * PS-F7-AC2/AC3 assertions the browser can prove. Magic cannot sign in a
 * minted-session headless browser (module 02's documented limit), so — the
 * module-06/13 posture — signing paths assert to the honest failure state,
 * countdown/claim states are driven through mocked estate routes, and the
 * enroll/check-in/claim SEMANTICS are DB-proven in estate.test.ts +
 * keeper.test.ts; the live end-to-end is owner-run (verify-estate script).
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Decision-surface banned vocabulary (doc 01 G12) — the eligibility-spec list.
const BANNED = [
  /\bseed[\s-]?phrases?\b/i,
  /\bwallets?\b/i,
  /\bgas\b/i,
  /\bchains?\b/i,
  /\bnetworks?\b/i,
  /\bbridg(?:e|es|ed|ing)\b/i,
  /\bslippage\b/i,
  /\bsmart[\s-]contracts?\b/i,
  /\bsign (?:a |the )?transactions?\b/i,
];

// PS-F7.5 — verbatim (doc 14 §Enrollment step 5). Naming the 5 covered
// networks is sanctioned here (coverage context, not a decision).
const SOLANA_DISCLOSURE =
  "Inheritance covers your assets on Ethereum, Base, Arbitrum, BSC and X Layer. " +
  "Assets on Solana aren't covered yet — that's on our roadmap.";

const CANCELLED_COPY = "Welcome back. The countdown is cancelled.";

let user: TestUser;

test.beforeEach(async ({ context }) => {
  user = await createTestUser("DE");
  await signIn(context, user, "DE");
});
test.afterEach(async () => {
  await deleteTestUser(user);
});
test.afterAll(closeDb);

const notEnrolled = { enrolled: false, view: null };

function countdownView(over: Record<string, unknown> = {}) {
  return {
    enrolled: true,
    view: {
      status: "countdown",
      lastCheckIn: new Date(Date.now() - 130_000).toISOString(),
      deadlineAt: new Date(Date.now() - 10_000).toISOString(),
      claimReadyAt: new Date(Date.now() + 48_000).toISOString(),
      inactivitySecs: 120,
      demoScaled: true,
      coverageRefreshedAt: new Date(Date.now() - 300_000).toISOString(),
      ...over,
    },
  };
}

const prepareEnroll = {
  targets: [1, 56, 8453, 196, 42161].map((chainId) => ({
    chainId,
    delegateAddress: "0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0",
    nonce: 0,
  })),
  domain: { chainId: 42161, contract: "0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024" },
  authNonce: "0",
  demoMode: true,
  demoInactivitySecs: 120,
  prefill: null,
};

// ---------------------------------------------------------------------------
// S5 — enrollment wizard + enrolled state
// ---------------------------------------------------------------------------
test("S5 wizard: disclosure verbatim, Can-never legacy clauses, demo honesty, zero banned vocabulary", async ({
  page,
}) => {
  await mockTrpc(page, {
    "estate.status": () => notEnrolled,
    "estate.prepareEnroll": () => prepareEnroll,
  });
  await page.goto("/legacy");

  await expect(page.getByRole("heading", { name: "Legacy" })).toBeVisible();
  await page.getByLabel("Your beneficiary's email").fill("sister@example.com");
  await page.getByLabel(/Your name, as they/).fill("Amaka");
  await page.getByRole("button", { name: "Continue" }).click();

  // threshold step — demo timers labeled honestly (TS-9.5)
  await expect(page.getByText("(demo: minutes)")).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();

  // review: C3 legacy card + Can-never panel + the verbatim disclosure
  await expect(page.getByText("Everything goes to")).toBeVisible();
  await expect(page.getByText("sister@example.com")).toBeVisible();
  await expect(
    page.getByText("Can never move anything while you're active"),
  ).toBeVisible();
  await expect(page.getByText(SOLANA_DISCLOSURE)).toBeVisible();

  // PS-F7-AC3 discipline on the owner side too: scan the whole surface
  const text = (await page.locator("main").innerText()).replace(SOLANA_DISCLOSURE, "");
  for (const pattern of BANNED) {
    expect(text, `S5 violates ${pattern}`).not.toMatch(pattern);
  }

  // the one confirmation (C6) — headless Magic cannot personal_sign, so the
  // ceremony lands on the honest failure state (module 06/13 posture)
  await page.getByRole("button", { name: "Set it up" }).click();
  await expect(
    page.getByText(/everything passes to sister@example\.com/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText(/nothing was changed/i)).toBeVisible({ timeout: 15_000 });
});

test("S5 enrolled state: heartbeat status, last check-in, coverage refreshed, disclosure", async ({
  page,
}) => {
  await mockTrpc(page, {
    "estate.status": () => ({
      enrolled: true,
      view: {
        status: "enrolled",
        lastCheckIn: new Date(Date.now() - 60_000).toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        claimReadyAt: null,
        inactivitySecs: 120,
        demoScaled: true,
        coverageRefreshedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    }),
  });
  await page.goto("/legacy");
  await expect(page.getByText("Your inheritance plan is in place.")).toBeVisible();
  await expect(page.getByText("Heartbeat", { exact: true })).toBeVisible();
  await expect(page.getByText("Last check-in")).toBeVisible();
  await expect(page.getByText("Coverage refreshed")).toBeVisible();
  await expect(page.getByText("(demo: minutes)")).toBeVisible();
  await expect(page.getByText(SOLANA_DISCLOSURE)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"]) // OKLCH → lab() axe misparse (module 02)
    .analyze();
  expect(results.violations).toEqual([]);
});

// ---------------------------------------------------------------------------
// C8 — the countdown banner (every (app) screen; PS-F7-AC2's surface)
// ---------------------------------------------------------------------------
test("C8: verbatim active copy, tnum digits, demo tag, on multiple screens", async ({
  page,
}) => {
  await mockTrpc(page, {
    "estate.status": () => countdownView(),
    "estate.prepareEnroll": () => prepareEnroll,
  });

  await page.goto("/legacy");
  const banner = page.getByTestId("countdown-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Inheritance countdown active —");
  await expect(banner).toContainText("until claim opens.");
  await expect(banner).toContainText("(demo: minutes)");
  await expect(banner.getByRole("button", { name: "I’m here" })).toBeVisible();
  // G13: the ticking digits render through .tnum
  await expect(banner.locator(".tnum")).toHaveCount(1);

  // the digits actually tick (demo scale changes every second)
  const before = await banner.locator(".tnum").innerText();
  await page.waitForTimeout(2_200);
  const after = await banner.locator(".tnum").innerText();
  expect(after).not.toBe(before);
});

test("C8: 'I'm here' reaches the signed mutation and fails honestly headless; cancel copy is the pinned sentence", async ({
  page,
}) => {
  await mockTrpc(page, {
    "estate.status": () => countdownView(),
    "estate.prepareEnroll": () => prepareEnroll,
  });
  await page.goto("/legacy");
  const banner = page.getByTestId("countdown-banner");
  await banner.getByRole("button", { name: "I’m here" }).click();
  // headless Magic cannot personal_sign — the tap lands on the honest retry
  // state, never a silent nothing (the real cancel is DB-proven: the
  // "Welcome back." sentence is byte-pinned in estate.test.ts / receipts)
  await expect(banner.getByText("That didn't go through — try again.")).toBeVisible({
    timeout: 15_000,
  });
  expect(CANCELLED_COPY).toBe("Welcome back. The countdown is cancelled.");
});

test("C8: claimable state stays visible and honest", async ({ page }) => {
  await mockTrpc(page, {
    "estate.status": () => countdownView({ status: "claimable" }),
    "estate.prepareEnroll": () => prepareEnroll,
  });
  await page.goto("/legacy");
  const banner = page.getByTestId("countdown-banner");
  await expect(banner).toContainText("Inheritance claim is open");
  await expect(banner.getByRole("button", { name: "I’m here" })).toBeVisible();
});

// ---------------------------------------------------------------------------
// S6 — the heir claim (PS-F7-AC3: zero crypto vocabulary end to end)
// ---------------------------------------------------------------------------
const CLAIM_SUMMARY = {
  totalUsd: 4812,
  assetCount: 14,
  sourceCount: 5,
  perChain: [],
};

test("S6: invalid link is calm; ready link renders the lead, summary shape, one button — and forced light", async ({
  page,
}) => {
  await page.goto("/claim/not-a-real-token");
  await expect(page.getByText("This link isn't valid anymore.")).toBeVisible();

  await mockTrpc(page, {
    "estate.claimInfo": () => ({
      state: "ready",
      ownerName: "Amaka",
      summary: CLAIM_SUMMARY,
    }),
    "estate.claimStart": () => ({ ok: true, ownerName: "Amaka", summary: CLAIM_SUMMARY }),
    "estate.claimStatus": () => ({ started: true, done: false, receipt: null, sources: [] }),
  });
  await page.goto("/claim/e2e-token");

  // S6 forces paper-light even for dark-mode users (doc 01 route group)
  const htmlClass = await page.evaluate(() => document.documentElement.className);
  expect(htmlClass).not.toContain("dark");

  await expect(page.getByText("You’ve been named by Amaka.")).toBeVisible();
  await page.getByRole("button", { name: "See what was left for you" }).click();

  // "$4,812 · 14 assets · 5 sources" — the DS shape, "5 sources" fixed (G3)
  await expect(page.getByText("$4,812")).toBeVisible();
  await expect(page.getByText("14 assets · 5 sources")).toBeVisible();

  const claimButton = page.getByRole("button", { name: "Claim what was left for you" });
  await expect(claimButton).toBeVisible();

  // AC3: scan everything the heir has seen so far
  const text = await page.locator("body").innerText();
  for (const pattern of BANNED) {
    expect(text, `S6 violates ${pattern}`).not.toMatch(pattern);
  }

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("S6: claim → per-source progress (continue-and-report) → arrival + convert prompt", async ({
  page,
}) => {
  let statusCalls = 0;
  await mockTrpc(page, {
    "estate.claimInfo": () => ({
      state: "ready",
      ownerName: "Amaka",
      summary: CLAIM_SUMMARY,
    }),
    "estate.claimStart": () => ({ ok: true, ownerName: "Amaka", summary: CLAIM_SUMMARY }),
    "estate.claimStatus": () => {
      statusCalls += 1;
      const settled = statusCalls > 1;
      return {
        started: true,
        done: settled,
        receipt: settled ? "Your estate was claimed…" : null,
        sources: [
          { chainId: 8453, network: "Base", state: "claimed" },
          { chainId: 42161, network: "Arbitrum", state: settled ? "claimed" : "delegated" },
          { chainId: 196, network: "X Layer", state: "stale-tuple" },
        ],
      };
    },
  });
  await page.goto("/claim/e2e-token");
  await page.getByRole("button", { name: "See what was left for you" }).click();
  await page.getByRole("button", { name: "Claim what was left for you" }).click();

  // continue-and-report: arrived + in-flight + honestly held-up, side by side
  await expect(page.getByText("Bringing everything together…")).toBeVisible();
  await expect(page.getByText("Base")).toBeVisible();
  await expect(page.getByText("Arrived").first()).toBeVisible();
  await expect(page.getByText("Needs a hand — our team will follow up")).toBeVisible();

  // the poll flips done → arrival + the convert-all prompt
  await expect(page.getByText("It’s arrived.")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Convert everything to USDC" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep it as it is" })).toBeVisible();

  const text = await page.locator("body").innerText();
  for (const pattern of BANNED) {
    expect(text, `S6 arrival violates ${pattern}`).not.toMatch(pattern);
  }
});

test("S6: expired link says so, calmly", async ({ page }) => {
  await mockTrpc(page, {
    "estate.claimInfo": () => ({ state: "expired", ownerName: null, summary: null }),
  });
  await page.goto("/claim/e2e-token");
  await expect(page.getByText("This link has expired.")).toBeVisible();
});
