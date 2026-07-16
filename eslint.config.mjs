import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

// eslint-config-next@16 ships native flat configs — scope them to the web
// app subtree; bare global-ignore entries pass through untouched.
const scopeToWeb = (configs) =>
  configs.map((c) =>
    Object.keys(c).length === 1 && c.ignores
      ? c
      : { ...c, files: ["apps/web/**/*.{js,jsx,ts,tsx}"] },
  );

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/dist-types/**",
      "contracts/**",
      "**/next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },

  // apps/web — Next's canonical rules, scoped to the app subtree.
  ...scopeToWeb(nextCoreWebVitals),
  ...scopeToWeb(nextTypescript),
  {
    files: ["apps/web/**"],
    settings: { next: { rootDir: "apps/web/" } },
  },

  // worker + packages + e2e + scripts — typescript-eslint (type errors are tsc -b's job).
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: [
      "apps/worker/**/*.ts",
      "packages/**/*.ts",
      "e2e/**/*.ts",
      "scripts/**/*.ts",
    ],
  })),

  // Env discipline (doc 00): every env read goes through the typed env module.
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read env via the typed env module (apps/web/env.ts or apps/worker/env.ts), never process.env.",
        },
      ],
    },
  },

  // Sanctioned exemptions — kept last so they win.
  {
    files: [
      "apps/web/env.ts",
      "apps/worker/env.ts",
      "packages/db/src/client.ts",
      "packages/db/drizzle.config.ts",
      // Sanctioned CLI entries: the $1 mainnet convert smoke (doc 03) and the $5
      // SPYx G2 buy (doc 05) read SMOKE_WALLET_PRIVATE_KEY / PARTICLE_* directly,
      // like config/tooling scripts rather than app runtime.
      "packages/ua/scripts/**/*.ts",
      "packages/registry/scripts/**/*.ts",
      // Worker rehearsal/smoke CLIs (doc 08): env-gated mainnet tools reading
      // opt-in override vars (WORKER_URL, STAGING_*, RETENIX_CONFIRM_SPEND).
      "apps/worker/scripts/**/*.ts",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "**/*.config.{js,mjs,cjs,ts,mts}",
      // e2e harness: runs outside the apps, drives them over HTTP, and mints a
      // session the way the server does (doc 02) rather than shipping a bypass.
      "e2e/support/**/*.ts",
    ],
    rules: { "no-restricted-properties": "off" },
  },
);
