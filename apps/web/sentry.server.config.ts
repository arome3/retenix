// Sentry — Node runtime (doc 17 §Observability).
//
// Loaded by instrumentation.ts's register() when NEXT_RUNTIME === "nodejs".
// Named *.config.ts deliberately: that pattern is the sanctioned process.env
// exemption in eslint.config.mjs, and the release SHA is only ever available as
// a platform variable.
import * as Sentry from "@sentry/nextjs";
import {
  resolveRelease,
  scrubBreadcrumb,
  scrubEvent,
} from "@retenix/shared/observability";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // A placeholder DSN disables Sentry rather than half-configuring it: a fresh
  // clone and CI both boot with sntrys_/PLACEHOLDER values (module 08's
  // placeholder-safe convention).
  enabled: !process.env.NEXT_PUBLIC_SENTRY_DSN?.includes("PLACEHOLDER"),
  release: resolveRelease({
    SENTRY_RELEASE: process.env.SENTRY_RELEASE,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    GITHUB_SHA: process.env.GITHUB_SHA,
  }),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0,
  // Never let the SDK volunteer identity. users stores email_hash, not email,
  // and doc 17 forbids emails reaching Sentry at all.
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
});
