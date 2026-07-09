import { config as dotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Tooling env: the root .env carries DATABASE_URL for db-backed tests locally;
// CI injects DATABASE_URL directly (dotenv never overrides real env).
dotenv({ path: ".env" });

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
          name: "web",
          environment: "node",
          include: ["apps/web/**/*.test.ts"],
          exclude: ["apps/web/.next/**", "**/node_modules/**"],
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
