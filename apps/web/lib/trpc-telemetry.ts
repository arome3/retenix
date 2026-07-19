import { createTRPCClient, httpBatchLink } from "@trpc/client";

import type { AppRouter } from "@/server/routers";

/**
 * Telemetry's own pipe (doc 17, PS-8.2).
 *
 * `keepalive` is the entire point. Module 02 lost the t=0 of the onboarding
 * measurement exactly once, because a navigation aborts an in-flight fetch —
 * and every event this client sends is emitted at a moment the user is about to
 * navigate away from. keepalive is sendBeacon's guarantee (the request outlives
 * the document) expressed through the typed client we already have, so nothing
 * has to be hand-serialised.
 *
 * Separate from trpc-vanilla so telemetry never batches with a real mutation,
 * and so keepalive's 64KB per-origin budget can never apply to one. These
 * payloads are ~90 bytes; keep it that way.
 */
export const trpcTelemetry = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      fetch: (url, options) => fetch(url, { ...options, keepalive: true }),
    }),
  ],
});
