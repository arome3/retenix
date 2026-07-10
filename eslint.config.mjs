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

  // worker + packages + e2e — typescript-eslint (type errors are tsc -b's job).
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["apps/worker/**/*.ts", "packages/**/*.ts", "e2e/**/*.ts"],
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
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "**/*.config.{js,mjs,cjs,ts,mts}",
    ],
    rules: { "no-restricted-properties": "off" },
  },
);
