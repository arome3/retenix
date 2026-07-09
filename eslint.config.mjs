import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

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
  ...compat
    .extends("next/core-web-vitals", "next/typescript")
    .map((c) => ({ ...c, files: ["apps/web/**/*.{js,jsx,ts,tsx}"] })),
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
