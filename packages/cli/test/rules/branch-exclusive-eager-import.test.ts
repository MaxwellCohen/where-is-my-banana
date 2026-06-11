import { describe, it, expect } from "vitest";
import { branchExclusiveEagerImport } from "../../src/rules/loading/branch-exclusive-eager-import.js";
import { buildGraph } from "../../src/graph/builder.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";
import { fixturePath, runScanOnFixture } from "../helpers.js";

describe("branch-exclusive-eager-import", () => {
  it("flags branch-exclusive HomeContent in Page.tsx", async () => {
    const projectRoot = fixturePath("branch-exclusive-eager");
    const graph = await buildGraph(projectRoot);
    const findings: Parameters<typeof branchExclusiveEagerImport.run>[0]["report"] extends (
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
          dynamicImportMinSubtree: 1,
        },
      },
      pkg: loadPackageInfo(projectRoot),
      data: loadDataTables(),
      nextConfig: null,
      byteAttribution: null,
      report: (f: (typeof findings)[number]) => findings.push(f),
    };

    branchExclusiveEagerImport.run(ctx);

    const pageFindings = findings.filter(
      (f) => f.ruleId === "branch-exclusive-eager-import" && f.file.includes("Page.tsx"),
    );
    expect(pageFindings.length).toBeGreaterThan(0);
    expect(pageFindings[0]?.evidence.component).toBe("HomeContent");
  });

  it("does not flag unconditionally used components", async () => {
    const findings = await runScanOnFixture("branch-exclusive-eager");
    const alwaysFindings = findings.filter(
      (f) =>
        f.ruleId === "branch-exclusive-eager-import" && f.file.includes("AlwaysUsed.tsx"),
    );
    expect(alwaysFindings).toHaveLength(0);
  });
});
