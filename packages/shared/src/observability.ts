// Sentry release identity + PII scrubbing (doc 17 §Observability, §Security).
//
// Shared by apps/web (browser, node, edge) and apps/worker (node), and reached
// ONLY through the "@retenix/shared/observability" subpath — never re-exported
// from src/index.ts, so pulling it into the browser bundle cannot drag ethers
// and zod along. Same rule, same reason, as escrow-crypto.ts.
//
// One module rather than four copies: doc 17 already insists there be exactly
// one notify helper, and the argument is stronger for a deny-list. A deny-list
// that exists in two places WILL drift, and drift here means a leak.
//
// Doc 17 §Security, verbatim: "no emails (we store hashes anyway), no
// signatures, no tuple material in breadcrumbs (doc 14 payloads redacted by
// type)."
//
// No runtime dependencies. The Sentry types are erased at compile time, so this
// file costs a browser bundle nothing.

export const REDACTED = "[redacted]";

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/**
 * Doc 17: "Release = git SHA on both." Resolved from whichever platform is
 * running us, passed in explicitly rather than read off process.env — this file
 * is imported by browser code, where process does not exist, and an explicit
 * source keeps every caller honest about where the value came from.
 *
 *   Vercel  → VERCEL_GIT_COMMIT_SHA
 *   Railway → RAILWAY_GIT_COMMIT_SHA
 *   Actions → GITHUB_SHA
 *   local   → undefined (events are simply not release-tagged)
 *
 * SENTRY_RELEASE wins when set, so a manual deploy can name its own release.
 */
export interface ReleaseSource {
  SENTRY_RELEASE?: string | undefined;
  VERCEL_GIT_COMMIT_SHA?: string | undefined;
  RAILWAY_GIT_COMMIT_SHA?: string | undefined;
  GITHUB_SHA?: string | undefined;
}

export function resolveRelease(source: ReleaseSource): string | undefined {
  const sha =
    source.SENTRY_RELEASE ||
    source.VERCEL_GIT_COMMIT_SHA ||
    source.RAILWAY_GIT_COMMIT_SHA ||
    source.GITHUB_SHA;
  // Full 40-char SHA, never trimmed: Sentry shortens it for display but needs
  // the whole value to associate commits with a release.
  return sha && sha.length > 0 ? sha : undefined;
}

// ---------------------------------------------------------------------------
// Deny-list
// ---------------------------------------------------------------------------

// Matched case-insensitively as a SUBSTRING of the key name, so `tuplesEnc`,
// `tuples_enc` and `escrowedTuples` all land on the same rule.
const DENIED_KEY_PARTS = [
  // doc 14 escrow material — the exfiltration target. A serialized 7702
  // authorization is a bearer capability over someone's EOA.
  "tuple",
  "authorization",
  "beneficiary",
  "salt",
  "escrow_dev_secret",
  "escrowdevsecret",
  // signatures — never useful in a breadcrumb, always sensitive
  "signature",
  "personal_sign",
  "rootsig",
  // credentials
  "privatekey",
  "private_key",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authtoken",
  "auth_token",
  "bearer",
  "cookie",
  "authorization",
  "internal_api_token",
  "internalapitoken",
  "keyid",
  "key_id",
  // raw identity — users.email_hash is the only email-shaped thing we store,
  // and a hash does not need to reach Sentry either.
  "email",
  // heir claim links are single-use bearer credentials living in a URL
  "claimtoken",
  "claim_token",
] as const;

export function isDeniedKey(key: string): boolean {
  const k = key.toLowerCase();
  return DENIED_KEY_PARTS.some((part) => k.includes(part));
}

// Value patterns, applied to strings we keep and to free text (messages,
// exception values, URLs).
//
// Deliberately NOT scrubbing bare 64-hex: uaTxId, txHash and rootHash are the
// load-bearing identifiers in every executor breadcrumb, and doc 08's whole
// failure story depends on them surviving into an incident. A secp256k1
// signature is 65 bytes = 130 hex characters, which is what the first pattern
// targets — long enough not to collide with a transaction hash.
const VALUE_PATTERNS: readonly RegExp[] = [
  /0x[0-9a-fA-F]{128,}/g, // serialized signatures / authorization tuples
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Magic keys
  /\bsntry[a-z]*_[A-Za-z0-9._-]{16,}/g, // Sentry auth tokens
  /\bre_[A-Za-z0-9_-]{16,}/g, // Resend keys
  /\bwhsec_[A-Za-z0-9_-]{16,}/g, // webhook signing keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic keys
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // any email that slips through by value
  /\/claim\/[A-Za-z0-9._-]{8,}/g, // heir claim links (the token IS the credential)
];

export function scrubString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

const MAX_DEPTH = 6;

/**
 * Deep-redact by key name, then by value pattern. Unknown shapes are the norm
 * in an error context, so this walks defensively and never throws — a scrubber
 * that can crash inside beforeSend takes the error report down with it.
 */
export function scrubValue(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof input === "string") return scrubString(input);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((v) => scrubValue(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = isDeniedKey(key) ? REDACTED : scrubValue(value, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sentry hooks
// ---------------------------------------------------------------------------

// Generic over `object` rather than typed against @sentry/*: this module is
// shared by three runtimes across two SDKs (@sentry/nextjs and @sentry/node)
// whose Event/Breadcrumb types differ in exact-optional and index-signature
// details. Every field is probed at RUNTIME, which is also the honest posture —
// an error event's shape is whatever the thing that blew up happened to attach.
type Loose = Record<string, unknown>;

const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null;

/** `beforeBreadcrumb` for both apps. Doc 08 emits one per pipeline step. */
export function scrubBreadcrumb<T extends object>(crumb: T): T {
  const c = crumb as Loose;
  if (typeof c["message"] === "string") c["message"] = scrubString(c["message"]);
  if (isObj(c["data"])) c["data"] = scrubValue(c["data"]);
  return crumb;
}

/** `beforeSend` for both apps. */
export function scrubEvent<T extends object>(event: T): T {
  const e = event as Loose;

  if (typeof e["message"] === "string") e["message"] = scrubString(e["message"]);
  for (const key of ["extra", "contexts", "tags"] as const) {
    if (isObj(e[key])) e[key] = scrubValue(e[key]);
  }

  // A user object is an identity by definition. Keep only the opaque id —
  // never email, username, or ip_address (users stores email_hash anyway).
  if (isObj(e["user"])) {
    const id = e["user"]["id"];
    e["user"] = id === undefined ? {} : { id: scrubValue(id) };
  }

  // Claim links and query strings ride in on the request URL.
  const request = e["request"];
  if (isObj(request)) {
    if (typeof request["url"] === "string") request["url"] = scrubString(request["url"]);
    if (isObj(request["headers"])) request["headers"] = scrubValue(request["headers"]);
  }

  // Exception messages routinely interpolate the very values above.
  const exception = e["exception"];
  if (isObj(exception) && Array.isArray(exception["values"])) {
    for (const value of exception["values"]) {
      if (isObj(value) && typeof value["value"] === "string") {
        value["value"] = scrubString(value["value"]);
      }
    }
  }
  return event;
}
