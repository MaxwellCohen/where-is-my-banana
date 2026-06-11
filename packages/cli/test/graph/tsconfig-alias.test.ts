import { describe, it, expect } from "vitest";
import { buildGraph } from "../../src/graph/builder.js";
import { branchExclusiveEagerImport } from "../../src/rules/loading/branch-exclusive-eager-import.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";
import { fixturePath } from "../helpers.js";

describe("tsconfig baseUrl aliases", () => {
  it("resolves components/* imports and flags branch-exclusive imports", async () => {
    const projectRoot = fixturePath("tsconfig-alias");
    const graph = await buildGraph(projectRoot);
    const pagePath = [...graph.modules.keys()].find((k) => k.endsWith("components/Page.tsx"));
    expect(pagePath).toBeDefined();

    const findings: { ruleId: string; evidence: Record<string, unknown> }[] = [];
    branchExclusiveEagerImport.run({
      projectRoot,
      graph,
      config: {
        ...DEFAULT_CONFIG,
        thresholds: { ...DEFAULT_CONFIG.thresholds, dynamicImportMinSubtree: 1 },
      },
      pkg: loadPackageInfo(projectRoot),
      data: loadDataTables(),
      nextConfig: null,
      byteAttribution: null,
      report: (f) => findings.push(f),
    });

    expect(
      findings.some(
        (f) =>
          f.ruleId === "branch-exclusive-eager-import" &&
          f.evidence.component === "HomeContent",
      ),
    ).toBe(true);
  });
});
