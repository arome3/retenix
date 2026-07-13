import { afterEach, describe, expect, it, vi } from "vitest";

// A complete, syntactically valid environment (canonical names, doc 00).
const VALID: Record<string, string> = {
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: "pk_live_test",
  MAGIC_SECRET_KEY: "sk_live_test",
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: "00000000-0000-0000-0000-000000000000",
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: "cK_test",
  NEXT_PUBLIC_PARTICLE_APP_UUID: "00000000-0000-0000-0000-000000000000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/retenix",
  ANTHROPIC_API_KEY: "sk-ant-test",
  SESSION_SECRET: "session-secret-test",
  APP_BASE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SENTRY_DSN: "https://x.ingest.sentry.io/0",
  SENTRY_AUTH_TOKEN: "sntrys_test",
  INTERNAL_API_TOKEN: "internal-test-token",
  DEMO_MODE: "0",
  RPC_URL_ETHEREUM: "https://eth-mainnet.g.alchemy.com/v2/test",
  RPC_URL_BASE: "https://base-mainnet.g.alchemy.com/v2/test",
  RPC_URL_ARBITRUM: "https://arb-mainnet.g.alchemy.com/v2/test",
  RPC_URL_BSC: "https://bnb-mainnet.g.alchemy.com/v2/test",
  RPC_URL_XLAYER: "https://rpc.xlayer.tech",
  RPC_URL_SOLANA: "https://solana-mainnet.g.alchemy.com/v2/test",
};

async function importEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  const merged = { ...VALID, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value as string);
  }
  return import("./env");
}

describe("web env module", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a complete environment", async () => {
    const mod = await importEnv({});
    expect(mod.env.APP_BASE_URL).toBe("http://localhost:3000");
    expect(mod.env.DEMO_MODE).toBe("0");
    expect(mod.clientEnv.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY).toBe("pk_live_test");
  });

  it("fails fast at import, naming the missing variable", async () => {
    await expect(importEnv({ SESSION_SECRET: undefined })).rejects.toThrow(
      /SESSION_SECRET/,
    );
  });

  it("names missing NEXT_PUBLIC client vars too", async () => {
    await expect(
      importEnv({ NEXT_PUBLIC_PARTICLE_PROJECT_ID: undefined }),
    ).rejects.toThrow(/NEXT_PUBLIC_PARTICLE_PROJECT_ID/);
  });

  it("requires the six scanner endpoints (doc 06) and names a missing one", async () => {
    await expect(importEnv({ RPC_URL_SOLANA: undefined })).rejects.toThrow(
      /RPC_URL_SOLANA/,
    );
  });

  it("rejects a malformed scanner endpoint (must be a URL)", async () => {
    await expect(importEnv({ RPC_URL_XLAYER: "not-a-url" })).rejects.toThrow(
      /RPC_URL_XLAYER/,
    );
  });
});
