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

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  webServer: {
    command: "pnpm --filter web dev",
    url: baseURL,
    cwd: "..",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
