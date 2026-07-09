import { z } from "zod";

// Canonical env-var names (doc 00 §Canonical environment variables) — never
// invent alternatives. Parsed at import time so boot fails fast, naming
// every missing or malformed variable.
const schema = z.object({
  DATABASE_URL: z.url(),
  PARTICLE_PROJECT_ID: z.string().min(1),
  PARTICLE_CLIENT_KEY: z.string().min(1),
  PARTICLE_APP_UUID: z.string().min(1),
  AWS_REGION: z.string().min(1),
  KMS_AGENT_KEY_ID: z.string().min(1),
  KMS_ESCROW_KEY_ID: z.string().min(1),
  // Dev-only raw key path (Particle's documented example flow); forbidden in
  // prod — production agent keys live in AWS KMS, never env vars.
  AGENT_EOA_PRIVATE_KEY: z.string().min(1).optional(),
  RPC_URL_ETHEREUM: z.url(),
  RPC_URL_BASE: z.url(),
  RPC_URL_ARBITRUM: z.url(),
  RPC_URL_BSC: z.url(),
  RPC_URL_XLAYER: z.url(),
  RPC_URL_SOLANA: z.url(),
  POLICY_CONTRACT_ADDRESS: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_ETHEREUM: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_BASE: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_ARBITRUM: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_BSC: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_XLAYER: z.string().min(1),
  ALCHEMY_WEBHOOK_SIGNING_KEY: z.string().min(1),
  SLACK_STATUS_WEBHOOK_URL: z.url(),
  SENTRY_DSN: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  DEMO_INACTIVITY_SECS: z.coerce.number().int().positive().default(120),
  DEMO_CHALLENGE_WINDOW_SECS: z.coerce.number().int().positive().default(60),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
  throw new Error(
    `[worker] invalid environment — missing or malformed: ${names.join(", ")}`,
  );
}

export const env = parsed.data;
