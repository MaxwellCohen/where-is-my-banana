import { describe, it, expect } from "vitest";
import { getAllRules } from "../../src/rules/index.js";
import type { RuleContext } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";
import { fixturePath } from "../helpers.js";

describe("rule registry", () => {
  it("has unique rule ids with categories", () => {
    const rules = getAllRules();
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of rules) {
      expect(rule.category.length).toBeGreaterThan(0);
    }
  });

  it("runs all rules without throwing on an empty graph", () => {
    const projectRoot = fixturePath("e2e-app");
    const findings: unknown[] = [];
    const ctx: RuleContext = {
      projectRoot,
      graph: {
        modules: new Map(),
        entries: [],
        clientModules: new Set(),
        serverModules: new Set(),
        sharedModules: new Set(),
      },
      config: DEFAULT_CONFIG,
      pkg: loadPackageInfo(projectRoot),
      data: loadDataTables(),
      nextConfig: null,
      byteAttribution: null,
      report: (f) => findings.push(f),
    };

    for (const rule of getAllRules()) {
      expect(() => rule.run(ctx)).not.toThrow();
    }
  });
});
