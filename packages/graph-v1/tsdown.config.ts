import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/parse-file.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
