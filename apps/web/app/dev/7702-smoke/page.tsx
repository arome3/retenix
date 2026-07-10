import { notFound } from "next/navigation";
import { Smoke7702 } from "./Smoke7702";

// Gate G1 (doc 16): headless sign7702Authorization on Arbitrum One, serialized
// via ethers.Signature. Not a product surface; 404s in production builds.
export default function Smoke7702Page() {
  // eslint-disable-next-line no-restricted-properties -- NODE_ENV is a build-time constant inlined by Next, not a runtime env var; the typed env module governs runtime config only
  if (process.env.NODE_ENV === "production") notFound();
  return <Smoke7702 />;
}
