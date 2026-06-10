/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: "custom-dist",
  optimizePackageImports: ["lodash-es", "date-fns"],
};

export default nextConfig;
