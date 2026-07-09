import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@retenix/db",
    "@retenix/shared",
    "@retenix/ua",
    "@retenix/registry",
  ],
  serverExternalPackages: ["pg"],
};

export default nextConfig;
