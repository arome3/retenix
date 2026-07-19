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
  // Module 14: the keeper builds heir claim links against the web origin
  // (doc 00 lists APP_BASE_URL web-side; the worker addition is doc 14's).
  APP_BASE_URL: z.url(),
  // Module 14 (PROPOSED — provider of choice, recorded for doc 17): Resend.
  // Absent → the keeper logs the claim link loudly instead of emailing
  // (console + Slack + events row) so the demo proceeds without a provider.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  // Module 14 dev-only escrow fallback (no AWS locally); forbidden in prod —
  // the escrow provider resolution throws if it would ever be used there.
  ESCROW_DEV_SECRET: z.string().min(8).optional(),
  SLACK_STATUS_WEBHOOK_URL: z.url(),
  SENTRY_DSN: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  DEMO_INACTIVITY_SECS: z.coerce.number().int().positive().default(120),
  DEMO_CHALLENGE_WINDOW_SECS: z.coerce.number().int().positive().default(60),
  // "1" enables demo-only affordances (the rogue-instruction trigger).
  // Doc 00 lists DEMO_MODE in the web table; the worker addition is doc 08's
  // (recorded in HANDOFF) — the rogue endpoint must not exist otherwise.
  DEMO_MODE: z.enum(["0", "1"]).default("0"),
  // Internal HTTP surface (execute-now / demo rogue / healthz). PROPOSED
  // (spec-silent): Railway injects PORT; 8080 is the local default.
  PORT: z.coerce.number().int().positive().default(8080),
  // Used only to fence dev-only affordances (raw agent key) out of prod.
  NODE_ENV: z.string().optional(),
  // DEMO-gated fault injection (doc 08 failure rehearsal): with DEMO_MODE=1,
  // executeLegForUser corrupts the root signature so the UA rejects the send
  // server-side — the honest failure ladder runs without moving funds.
  FAULT_INJECT_UA: z.enum(["corrupt-root-sig"]).optional(),
  // PROPOSED (doc 12): the snapshot cron's display-marks source — the worker
  // mirror of the web's NEXT_PUBLIC_PORTFOLIO_LIVE marks half (separate
  // process env; set the two together so the statement and its history agree).
  PORTFOLIO_MARKS: z.enum(["jupiter", "last-trade"]).default("jupiter"),

  // --- module 17 (doc 17) ---------------------------------------------------
  // Sentry release = git SHA (doc 17 §Observability). Railway injects the first
  // automatically; SENTRY_RELEASE lets a manual deploy name its own. Absent
  // locally, where events simply are not release-tagged.
  RAILWAY_GIT_COMMIT_SHA: z.string().min(7).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  // Deny-by-default for /internal/* arriving through a PUBLIC edge (TS-13.2).
  // Railway's edge sets x-forwarded-for; a private-network caller does not.
  // PROPOSED (spec-silent) — the spec asks for private networking, which cannot
  // reach across clouds (see HANDOFF); this is the enforceable half.
  // prod = "1". staging = "0", because e2e drives /internal/demo/rogue over the
  // public domain. Default off so no existing environment changes behaviour.
  INTERNAL_ROUTES_PRIVATE_ONLY: z.enum(["0", "1"]).default("0"),
  // Chainlink upkeep LINK-balance alert (doc 14 requires the alert and gives no
  // number; contracts/script/RegisterUpkeep.md specifies a >=5 LINK starting
  // deposit on One, so 2 is 40% of it). PROPOSED — resize once OQ6 confirms the
  // Arbitrum premium at registration.
  LINK_BALANCE_WARN: z.coerce.number().positive().default(2),
  // The LINK token + registry to read that balance from. Absent → the check is
  // skipped and says so, rather than paging on an unconfigured upkeep.
  LINK_TOKEN_ADDRESS: z.string().min(1).optional(),
  CHAINLINK_UPKEEP_ADMIN: z.string().min(1).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
  throw new Error(
    `[worker] invalid environment — missing or malformed: ${names.join(", ")}`,
  );
}

export const env = parsed.data;
