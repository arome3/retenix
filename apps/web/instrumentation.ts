// Fail-fast env validation at server boot (dev + start) — a missing variable
// kills the process by name instead of surfacing as a runtime undefined.
//
// The env import stays FIRST and stays awaited (module 17): Sentry is worth
// nothing if the process is about to die on a missing DATABASE_URL, and an env
// failure must surface as itself rather than as a Sentry init error.
export async function register() {
  await import("./env");

  // NEXT_RUNTIME is set by Next itself, not by deployment configuration, so it
  // has no place in the typed env module — putting it there would make the app
  // demand the variable exist at boot. Selecting a runtime's Sentry config this
  // way is the documented pattern; precedent for an inline exemption is
  // app/dev/tokens/page.tsx.
  // eslint-disable-next-line no-restricted-properties
  const runtime = process.env.NEXT_RUNTIME;

  if (runtime === "nodejs") await import("./sentry.server.config");
  if (runtime === "edge") await import("./sentry.edge.config");
}

// Errors from Server Components, route handlers, and proxy.ts — the surfaces
// no try/catch in app code ever sees.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
