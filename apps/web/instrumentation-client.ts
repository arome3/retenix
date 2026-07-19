// Sentry — browser (doc 17 §Observability).
//
// `instrumentation-client.ts`, NOT `sentry.client.config.ts`: Next 16 runs
// Turbopack by default, and Turbopack does not auto-import the legacy filename
// the way the webpack build did. This is the supported client hook.
//
// The DSN comes from the typed env module, not process.env — clientEnv is what
// Next inlines into the bundle, and reading process.env here is a lint error
// (the *.config.ts exemption does not cover this filename).
//
// The release is NOT set here on purpose. withSentryConfig's build plugin
// injects it into the client bundle from the same value next.config.ts
// resolves, so hard-coding a second source would be the one place web and
// server could disagree about which build an event came from.
import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "@retenix/shared/observability";

import { clientEnv } from "./env";

Sentry.init({
  dsn: clientEnv.NEXT_PUBLIC_SENTRY_DSN,
  // A fresh clone and CI both boot on a PLACEHOLDER DSN; disable rather than
  // half-configure (module 08's placeholder-safe convention).
  enabled: !clientEnv.NEXT_PUBLIC_SENTRY_DSN.includes("PLACEHOLDER"),
  tracesSampleRate: 0,
  // The browser is where a real email is actually typed (the OTP field), so
  // volunteering PII here is the highest-risk default in the whole SDK.
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
});

// Doc 17 wants navigation errors attributable to a build; this is the hook
// Next's App Router calls on client-side route transitions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
