import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  transpilePackages: ["@wimb/graph-v1"],
  outputFileTracingRoot: join(packageDir, "../.."),
};

export default nextConfig;
