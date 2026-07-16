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
  // doc 10: plan relay — the well-known anvil dev key #0 (a public test
  // constant, not a credential); route tests mock the relay itself.
  RELAYER_PRIVATE_KEY:
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  POLICY_CHAIN_ID: "421614",
  RPC_URL_ARBITRUM_SEPOLIA: "https://sepolia-rollup.arbitrum.io/rpc",
  APP_BASE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SENTRY_DSN: "https://x.ingest.sentry.io/0",
  SENTRY_AUTH_TOKEN: "sntrys_test",
  INTERNAL_API_TOKEN: "internal-test-token",
  DEMO_MODE: "1",
  // doc 06: the web server env now requires the six scanner endpoints.
  RPC_URL_ETHEREUM: "https://eth-mainnet.g.alchemy.com/v2/test",
  RPC_URL_BASE: "https://base-mainnet.g.alchemy.com/v2/test",
  RPC_URL_ARBITRUM: "https://arb-mainnet.g.alchemy.com/v2/test",
  RPC_URL_BSC: "https://bnb-mainnet.g.alchemy.com/v2/test",
  RPC_URL_XLAYER: "https://rpc.xlayer.tech",
  RPC_URL_SOLANA: "https://solana-mainnet.g.alchemy.com/v2/test",
};

// apps/worker modules import ../env, which parses at import time (doc 08).
// Same discipline as webTestEnv: placeholders for everything except
// DATABASE_URL, which db-backed worker tests take from the real environment.
const workerTestEnv = {
  PARTICLE_PROJECT_ID: "00000000-0000-0000-0000-000000000000",
  PARTICLE_CLIENT_KEY: "cK_test",
  PARTICLE_APP_UUID: "00000000-0000-0000-0000-000000000000",
  AWS_REGION: "us-east-1",
  KMS_AGENT_KEY_ID: "arn:aws:kms:us-east-1:0:key/agent",
  KMS_ESCROW_KEY_ID: "arn:aws:kms:us-east-1:0:key/escrow",
  RPC_URL_ETHEREUM: "https://eth-mainnet.g.alchemy.com/v2/test",
  RPC_URL_BASE: "https://base-mainnet.g.alchemy.com/v2/test",
  RPC_URL_ARBITRUM: "https://arb-mainnet.g.alchemy.com/v2/test",
  RPC_URL_BSC: "https://bnb-mainnet.g.alchemy.com/v2/test",
  RPC_URL_XLAYER: "https://rpc.xlayer.tech",
  RPC_URL_SOLANA: "https://solana-mainnet.g.alchemy.com/v2/test",
  POLICY_CONTRACT_ADDRESS: "0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024",
  CLAIM_DELEGATE_ADDRESS_ETHEREUM: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_BASE: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_ARBITRUM: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_BSC: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_XLAYER: "0x0000000000000000000000000000000000000000",
  ALCHEMY_WEBHOOK_SIGNING_KEY: "whsec_test",
  SLACK_STATUS_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/x",
  SENTRY_DSN: "https://x.ingest.sentry.io/0",
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
          env: workerTestEnv,
        },
      },
    ],
  },
});
