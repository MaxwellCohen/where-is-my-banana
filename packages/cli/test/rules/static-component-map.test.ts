import { describe, it, expect } from "vitest";
import { staticComponentMap } from "../../src/rules/loading/static-component-map.js";
import { buildGraph } from "../../src/graph/builder.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";
import { fixturePath, runScanOnFixture } from "../helpers.js";

describe("static-component-map", () => {
  it("flags registry.tsx with a large static component map", async () => {
    const projectRoot = fixturePath("static-component-map");
    const graph = await buildGraph(projectRoot);
    const findings: Parameters<typeof staticComponentMap.run>[0]["report"] extends (
      f: infer F,
    ) => void
      ? F[]
      : never[] = [];

    const ctx = {
      projectRoot,
      graph,
      config: {
        ...DEFAULT_CONFIG,
        thresholds: {
          ...DEFAULT_CONFIG.thresholds,
          componentMapMinEntries: 3,
          componentMapMinImports: 3,
        },
      },
      pkg: loadPackageInfo(projectRoot),
      data: loadDataTables(),
      nextConfig: null,
      byteAttribution: null,
      report: (f: (typeof findings)[number]) => findings.push(f),
    };

    staticComponentMap.run(ctx);

    const registryFindings = findings.filter(
      (f) => f.ruleId === "static-component-map" && f.file.includes("registry.tsx"),
    );
    expect(registryFindings.length).toBeGreaterThan(0);
    expect(registryFindings[0]?.evidence.exportName).toBe("Components");
    expect(registryFindings[0]?.evidence.importedComponentCount).toBeGreaterThanOrEqual(3);
  });

  it("does not flag literal translation maps", async () => {
    const findings = await runScanOnFixture("static-component-map");
    const translationFindings = findings.filter(
      (f) => f.ruleId === "static-component-map" && f.file.includes("translations.ts"),
    );
    expect(translationFindings).toHaveLength(0);
  });
});
