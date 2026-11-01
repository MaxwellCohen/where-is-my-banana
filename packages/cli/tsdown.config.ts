import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  // @wimb/graph-v1 is private: inline it so the published CLI is standalone.
  fixedExtension: false,
  deps: { alwaysBundle: [/^@wimb\/graph-v1/] },
});
