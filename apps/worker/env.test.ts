import { afterEach, describe, expect, it, vi } from "vitest";

// A complete, syntactically valid environment (canonical names, doc 00).
const VALID: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/retenix",
  PARTICLE_PROJECT_ID: "00000000-0000-0000-0000-000000000000",
  PARTICLE_CLIENT_KEY: "cK_test",
  PARTICLE_APP_UUID: "00000000-0000-0000-0000-000000000000",
  AWS_REGION: "us-east-1",
  KMS_AGENT_KEY_ID: "arn:aws:kms:us-east-1:0:key/agent",
  KMS_ESCROW_KEY_ID: "arn:aws:kms:us-east-1:0:key/escrow",
  RPC_URL_ETHEREUM: "https://rpc.test/eth",
  RPC_URL_BASE: "https://rpc.test/base",
  RPC_URL_ARBITRUM: "https://rpc.test/arb",
  RPC_URL_BSC: "https://rpc.test/bsc",
  RPC_URL_XLAYER: "https://rpc.test/xlayer",
  RPC_URL_SOLANA: "https://rpc.test/sol",
  POLICY_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_ETHEREUM: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_BASE: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_ARBITRUM: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_BSC: "0x0000000000000000000000000000000000000000",
  CLAIM_DELEGATE_ADDRESS_XLAYER: "0x0000000000000000000000000000000000000000",
  ALCHEMY_WEBHOOK_SIGNING_KEY: "whsec_test",
  SLACK_STATUS_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/x",
  SENTRY_DSN: "https://x.ingest.sentry.io/0",
  INTERNAL_API_TOKEN: "internal-test-token",
  // Pinned here because the vitest worker project injects DEMO_MODE=1 for
  // executor/http tests; the default-value assertions below need it absent.
  DEMO_MODE: "0",
};

async function importEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  const merged = { ...VALID, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value as string);
  }
  return import("./env");
}

describe("worker env module", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a complete environment and applies demo defaults", async () => {
    const { env } = await importEnv({});
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.DEMO_INACTIVITY_SECS).toBe(120);
    expect(env.DEMO_CHALLENGE_WINDOW_SECS).toBe(60);
    expect(env.DEMO_MODE).toBe("0"); // demo affordances default OFF
    expect(env.PORT).toBe(8080);
  });

  it("accepts DEMO_MODE=1 and rejects other values", async () => {
    const on = await importEnv({ DEMO_MODE: "1" });
    expect(on.env.DEMO_MODE).toBe("1");
    await expect(importEnv({ DEMO_MODE: "yes" })).rejects.toThrow(/DEMO_MODE/);
  });

  it("fails fast at import, naming the missing variable", async () => {
    await expect(importEnv({ KMS_AGENT_KEY_ID: undefined })).rejects.toThrow(
      /KMS_AGENT_KEY_ID/,
    );
  });

  it("names malformed values too", async () => {
    await expect(importEnv({ RPC_URL_SOLANA: "not-a-url" })).rejects.toThrow(
      /RPC_URL_SOLANA/,
    );
  });
});
