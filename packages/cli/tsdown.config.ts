import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: true,
  // Standalone npx/tarball installs (no npm publish for @wimb/graph-v1).
  noExternal: ["@wimb/graph-v1"],
});
