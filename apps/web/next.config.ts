import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Monorepo root (silences Next's multi-lockfile inference warning).
  turbopack: { root: path.join(__dirname, "..", "..") },
  transpilePackages: [
    "@retenix/db",
    "@retenix/shared",
    "@retenix/ua",
    "@retenix/registry",
  ],
  serverExternalPackages: ["pg"],
};

// Doc 17 §Observability: release = git SHA, resolved once here so all three
// runtimes and the uploaded source maps agree on which build an event is from.
// Vercel exposes VERCEL_GIT_COMMIT_SHA; GitHub Actions GITHUB_SHA; locally it
// is undefined and events are simply not release-tagged.
const release =
  process.env.SENTRY_RELEASE ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA;

// Source-map upload needs a real token. CI and a fresh clone build on the
// committed sntrys_PLACEHOLDER, so gate on it: an unauthenticated upload
// attempt would fail the build on the artifact judges click.
const canUploadSourceMaps = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
    !process.env.SENTRY_AUTH_TOKEN.includes("PLACEHOLDER"),
);

// org/project are deliberately NOT named here: the Sentry build plugin reads
// SENTRY_ORG / SENTRY_PROJECT from the environment itself, and doc 17's hard
// constraint is that env names come from doc 00's canonical table. Those two are
// Sentry CLI conventions used only at BUILD time (never app runtime config), so
// they are set in the Vercel dashboard and never restated as new names in code.
export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Injects `release` into the client bundle too, which is why
  // instrumentation-client.ts deliberately does not set one of its own.
  release: release ? { name: release } : undefined,
  sourcemaps: { disable: !canUploadSourceMaps },
  // Prettier stack traces across the client chunks (doc 17: source maps via
  // SENTRY_AUTH_TOKEN).
  widenClientFileUpload: true,
  // Routes browser events through our own origin so an ad blocker cannot
  // silently swallow the client half of an incident.
  tunnelRoute: "/monitoring",
  disableLogger: true,
});
