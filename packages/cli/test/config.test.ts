import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, parseNextConfig, parseNextConfigFromSource } from "../src/config.js";
import { fixturePath } from "./helpers.js";

describe("mergeConfig", () => {
  it("deep-merges partial thresholds", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      thresholds: { subtreeBytesHigh: 100_000 },
    });
    expect(merged.thresholds.subtreeBytesHigh).toBe(100_000);
    expect(merged.thresholds.heavyPackageBytes).toBe(DEFAULT_CONFIG.thresholds.heavyPackageBytes);
  });

  it("concatenates and dedupes ignore lists", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      ignores: { files: ["**/test/**"], rules: ["unused-dependency"] },
    });
    expect(merged.ignores.files).toEqual(["**/test/**"]);
    expect(merged.ignores.rules).toEqual(["unused-dependency"]);
  });
});

describe("parseNextConfig", () => {
  it("loads js/mjs config at runtime", async () => {
    const config = await parseNextConfig(fixturePath("next-config/js"));
    expect(config?.distDir).toBe("custom-dist");
    expect(config?.optimizePackageImports).toContain("lodash-es");
  });

  it("falls back to regex for unreadable ts config", async () => {
    const config = await parseNextConfig(fixturePath("next-config/regex-fallback"));
    expect(config?.distDir).toBe("regex-dist");
    expect(config?.optimizePackageImports).toContain("ramda");
  });
});

describe("parseNextConfigFromSource", () => {
  it("extracts distDir from source text", () => {
    const config = parseNextConfigFromSource("export default { distDir: 'out' }");
    expect(config.distDir).toBe("out");
  });
});
