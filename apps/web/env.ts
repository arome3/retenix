import { z } from "zod";

// Canonical env-var names (doc 00 §Canonical environment variables) — never
// invent alternatives. Parsed at import time; instrumentation.ts imports this
// module so `next dev` / `next start` fail at boot naming every missing or
// malformed variable. Reading process.env anywhere else is a lint error.

const serverSchema = z.object({
  MAGIC_SECRET_KEY: z.string().min(1),
  DATABASE_URL: z.url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  APP_BASE_URL: z.url(),
  SENTRY_AUTH_TOKEN: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  // "1" enables demo-only affordances (rogue-instruction trigger, demo-scaled defaults).
  DEMO_MODE: z.enum(["0", "1"]).default("0"),
  // PROPOSED (doc 10, spec-silent — flagged in HANDOFF for doc 00's table):
  // the plan-relay signing key. Dev-only raw key per doc 00's custody rule
  // (KMS in prod); it pays Arbitrum gas for createPlan/revokePlanFor relays.
  // Validated as hex at relay construction, not here, so placeholder-cred
  // boots stay green (module 08's degraded-boot convention).
  RELAYER_PRIVATE_KEY: z.string().min(1),
  // PROPOSED (doc 10): which RetenixPolicy deployment plans.* writes —
  // Arbitrum One in prod/demo, Sepolia for integration rehearsal.
  POLICY_CHAIN_ID: z.enum(["42161", "421614"]).default("42161"),
  // Required only when POLICY_CHAIN_ID=421614 (Sepolia has no canonical
  // RPC_URL_* row in doc 00); checked at relay construction.
  RPC_URL_ARBITRUM_SEPOLIA: z.url().optional(),
  // PROPOSED (doc 06, spec-silent): doc 00 lists these six under the WORKER's
  // table; the web server also needs them for the dust scanner (sweep.preview /
  // sweep.execute re-scan). Same canonical names, never NEXT_PUBLIC_ — the
  // browser must never read RPC endpoints.
  RPC_URL_ETHEREUM: z.url(),
  RPC_URL_BASE: z.url(),
  RPC_URL_ARBITRUM: z.url(),
  RPC_URL_BSC: z.url(),
  RPC_URL_XLAYER: z.url(),
  RPC_URL_SOLANA: z.url(),
  // Module 14 (doc 00 canonical names): the estate escrow key + the deployed
  // RetenixClaim delegates the tuple ceremony points at. The web server
  // ENCRYPTS at estate.enroll (decrypt lives worker-side only); placeholder
  // values keep boot green — the KMS/dev fence lands at first use
  // (server/lib/estate.ts, module 08's degraded-boot convention).
  KMS_ESCROW_KEY_ID: z.string().min(1),
  AWS_REGION: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_ETHEREUM: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_BASE: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_ARBITRUM: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_BSC: z.string().min(1),
  CLAIM_DELEGATE_ADDRESS_XLAYER: z.string().min(1),
  // Dev-only escrow fallback secret (no AWS in local dev). Forbidden in
  // production — server/lib/estate.ts throws if it would ever be used there.
  ESCROW_DEV_SECRET: z.string().min(8).optional(),
  // Doc 00 lists this worker-side; enrollment (web) substitutes it into
  // inactivitySecs when DEMO_MODE=1 (TS-9.5 — at enrollment time only).
  DEMO_INACTIVITY_SECS: z.coerce.number().int().positive().default(120),
});

const clientSchema = z.object({
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: z.string().min(1),
  NEXT_PUBLIC_PARTICLE_APP_UUID: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1),
  // PROPOSED (doc 12) — the ONE flag the doc puts its open questions behind:
  // "1" = live Jupiter display marks + the Sell action; "0" = last-trade
  // marks only, Sell hidden (and its mutation refuses). Client-inlined AND
  // server-readable; the worker mirrors the marks half as PORTFOLIO_MARKS
  // (separate process env — set the two together). Owner review by W3.
  NEXT_PUBLIC_PORTFOLIO_LIVE: z.enum(["0", "1"]).default("1"),
});

function invalid(names: string[]): never {
  throw new Error(
    `[web] invalid environment — missing or malformed: ${names.join(", ")}`,
  );
}

function issueNames(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => i.path.join(".")))];
}

// NEXT_PUBLIC_ values must be referenced statically for Next's inliner.
const parsedClient = clientSchema.safeParse({
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY,
  NEXT_PUBLIC_PARTICLE_PROJECT_ID: process.env.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
  NEXT_PUBLIC_PARTICLE_CLIENT_KEY: process.env.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
  NEXT_PUBLIC_PARTICLE_APP_UUID: process.env.NEXT_PUBLIC_PARTICLE_APP_UUID,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_PORTFOLIO_LIVE: process.env.NEXT_PUBLIC_PORTFOLIO_LIVE,
});
if (!parsedClient.success) invalid(issueNames(parsedClient.error));

export const clientEnv: z.infer<typeof clientSchema> = parsedClient.data;

// Server vars are validated only on the server; importing clientEnv from a
// client component must not evaluate (or leak) the server schema.
export const env: z.infer<typeof serverSchema> = (() => {
  if (typeof window !== "undefined") {
    return new Proxy({} as z.infer<typeof serverSchema>, {
      get() {
        throw new Error("[web] server env accessed in the browser");
      },
    });
  }
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) invalid(issueNames(parsed.error));
  return parsed.data;
})();

// Gate for stubs that must never reach a real user: the eligibility pass-through
// doc 04 replaces (doc 02). NODE_ENV is a build-time constant Next inlines, so a
// production build can only ever evaluate this to false. Short-circuits before
// touching `env`, which throws in the browser.
export const devAffordances: boolean =
  typeof window === "undefined" &&
  process.env.NODE_ENV !== "production" &&
  env.DEMO_MODE === "1";

// Module 14's escrow dev-fence (and any future "never in prod" guard) reads
// this instead of process.env — NODE_ENV stays confined to this sanctioned file.
export const isProductionRuntime: boolean = process.env.NODE_ENV === "production";
