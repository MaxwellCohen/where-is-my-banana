import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, parseNextConfig, parseNextConfigFromSource } from "../src/config.js";
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

describe("loadConfig", () => {
  it("loads a TypeScript wimb.config.ts and merges it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-cfg-"));
    try {
      writeFileSync(join(dir, "wimb.config.ts"), 'const c: { ignores: { rules: string[] } } = { ignores: { rules: ["unused-dependency"] } };\nexport default c;\n');
      const cfg = await loadConfig(dir);
      expect(cfg.ignores.rules).toEqual(["unused-dependency"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on stderr and uses defaults when the config is broken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-cfg-"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "wimb.config.ts"), 'throw new Error("boom");\n');
      const cfg = await loadConfig(dir);
      expect(cfg).toEqual(DEFAULT_CONFIG);
      expect(spy.mock.calls[0][0]).toMatch(/^wimb: could not load wimb\.config\.ts: .*boom.*; using defaults$/);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
