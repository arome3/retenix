import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@/server/routers";

/**
 * A vanilla (non-React) tRPC client for code that runs outside the component tree —
 * e.g. lib/post-login.ts firing account.bootstrap right after the session lands. The
 * React client (lib/trpc.ts) is for components; this shares the same /api/trpc pipe.
 * Relative URL: resolves against the current origin in the browser.
 */
export const trpcVanilla = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc" })],
});
