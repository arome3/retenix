// Sentry — Edge runtime (doc 17 §Observability).
//
// Loaded by instrumentation.ts when NEXT_RUNTIME === "edge". Retenix's only
// edge surface is proxy.ts (Next 16's name for middleware), which enforces the
// region gate — so this is the runtime where a redirect-loop or a malformed
// session cookie would surface (module 02 shipped exactly that bug once).
import * as Sentry from "@sentry/nextjs";
import {
  resolveRelease,
  scrubBreadcrumb,
  scrubEvent,
} from "@retenix/shared/observability";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !process.env.NEXT_PUBLIC_SENTRY_DSN?.includes("PLACEHOLDER"),
  release: resolveRelease({
    SENTRY_RELEASE: process.env.SENTRY_RELEASE,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    GITHUB_SHA: process.env.GITHUB_SHA,
  }),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0,
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
});
