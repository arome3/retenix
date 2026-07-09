import { defineConfig } from "@playwright/test";

// Golden-path specs over the demo beats land in module 16; config-only scaffold.
export default defineConfig({
  testDir: ".",
  use: {
    baseURL: process.env.APP_BASE_URL ?? "http://localhost:3000",
  },
});
