// Fail-fast env validation at server boot (dev + start) — a missing variable
// kills the process by name instead of surfacing as a runtime undefined.
// `next build` stays env-free by design.
export async function register() {
  await import("./env");
}
