import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Tooling env: the root .env carries DATABASE_URL for db-backed tests locally;
// CI injects DATABASE_URL directly (dotenv never overrides real env).
dotenv({ path: ".env" });

const webDir = fileURLToPath(new URL("./apps/web", import.meta.url));

// apps/web modules import the typed env module, which parses at import time.
// Supply syntactically valid placeholders for everything except DATABASE_URL,
// which must stay whatever the real environment provides (doc 02).
const webTestEnv = {
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: "pk_live_test",
  MAGIC_SECRET_KEY: "sk_live_test",
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: "00000000-0000-0000-0000-000000000000",
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: "cK_test",
  NEXT_PUBLIC_PARTICLE_APP_UUID: "00000000-0000-0000-0000-000000000000",
  ANTHROPIC_API_KEY: "sk-ant-test",
  SESSION_SECRET: "session-secret-test",
  APP_BASE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SENTRY_DSN: "https://x.ingest.sentry.io/0",
  SENTRY_AUTH_TOKEN: "sntrys_test",
  INTERNAL_API_TOKEN: "internal-test-token",
  DEMO_MODE: "1",
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          environment: "node",
          include: ["packages/shared/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "db",
          environment: "node",
          include: ["packages/db/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "ua",
          environment: "node",
          include: ["packages/ua/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "registry",
          environment: "node",
          include: ["packages/registry/src/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: { "@": webDir } },
        test: {
          name: "web",
          environment: "node",
          include: ["apps/web/**/*.test.ts"],
          exclude: ["apps/web/.next/**", "**/node_modules/**"],
          env: webTestEnv,
        },
      },
      {
        test: {
          name: "worker",
          environment: "node",
          include: ["apps/worker/**/*.test.ts"],
        },
      },
    ],
  },
});
