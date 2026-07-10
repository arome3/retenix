import { notFound } from "next/navigation";
import { TokenSheet } from "./TokenSheet";

// Dev-only token sheet (doc 01 test plan): every primitive, the type scale,
// and the base components in light/dark/±cvd — for eyeballing and screenshot
// diffing. Not a product surface; 404s in production builds.
export default function TokensPage() {
  // eslint-disable-next-line no-restricted-properties -- NODE_ENV is a build-time constant inlined by Next, not a runtime env var; the typed env module governs runtime config only
  if (process.env.NODE_ENV === "production") notFound();
  return <TokenSheet />;
}
