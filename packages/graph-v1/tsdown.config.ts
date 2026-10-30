import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", "parse-file": "src/parse-file.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
});
