import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Tooling env: the repo-root .env carries DATABASE_URL for local drizzle-kit
// runs; CI injects DATABASE_URL directly (dotenv never overrides real env).
config({ path: "../../.env" });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
