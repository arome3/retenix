import path from "node:path";
import { config as dotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

// Golden-path specs over the demo beats land in module 16. Module 02 adds the
// onboarding, session, and copy-canon specs, which need SESSION_SECRET and
// DATABASE_URL to mint a session the way the server does (e2e/support/session.ts).
// Resolve against this file, not the cwd — `pnpm e2e` runs from the repo root.
dotenv({ path: path.resolve(__dirname, "../.env") });
dotenv({ path: path.resolve(__dirname, "../apps/web/.env.local") });

const baseURL = process.env.APP_BASE_URL ?? "http://localhost:3000";

// Module 17: a remote target owns its own server. Booting `next dev` against a
// staging URL makes Playwright wait on a port nothing local is listening to and
// then fail with "url is already used" — so the webServer block only applies
// when baseURL is local. Inert for every existing path (APP_BASE_URL is unset
// or localhost in dev, CI, and .env.local).
const isLocalTarget = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseURL);

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  globalTeardown: path.resolve(__dirname, "support/global-teardown.ts"),
  // The dev server compiles routes on demand. On a cold start, several workers
  // each waiting on a first compile will blow the stock 30s/5s budgets — the
  // tests should tolerate that, not race it.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // CI runners are noisier than a laptop; one retry absorbs the known cold-compile
  // flakes (buying-power skeleton, kill progress) without hiding a real failure.
  retries: process.env.CI ? 1 : 0,
  webServer: isLocalTarget
    ? {
        command: "pnpm --filter web dev",
        url: baseURL,
        cwd: "..",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
