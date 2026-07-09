import path from "node:path";
import type { NextConfig } from "next";

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

export default nextConfig;
