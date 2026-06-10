import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: "regex-dist",
  optimizePackageImports: ["ramda"],
};

export default config;
