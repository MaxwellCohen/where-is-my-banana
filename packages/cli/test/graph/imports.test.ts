import { describe, it, expect } from "vitest";
import { buildGraph } from "../../src/graph/builder.js";
import { runScanOnFixture, fixturePath } from "../helpers.js";

describe("dynamic imports", () => {
  it("marks next/dynamic inner imports as dynamic", async () => {
    const graph = await buildGraph(fixturePath("dynamic-import"));
    const lazyChart = [...graph.modules.values()].find((m) => m.filePath.includes("lazy-chart"));
    expect(lazyChart?.imports.some((i) => i.specifier === "recharts" && i.isDynamic)).toBe(true);
  });

  it("flags static heavy import but not dynamic import page", async () => {
    const graph = await buildGraph(fixturePath("dynamic-import"));
    const staticChartPath = [...graph.modules.keys()].find((k) => k.includes("static-chart"));
    expect(staticChartPath).toBeDefined();
    expect(graph.clientModules.has(staticChartPath!)).toBe(true);

    const findings = await runScanOnFixture("dynamic-import");
    const staticFindings = findings.filter(
      (f) =>
        f.ruleId === "missing-dynamic-import" &&
        (f.file.includes("static-chart") || f.evidence.package === "recharts"),
    );
    const dynamicFindings = findings.filter(
      (f) => f.ruleId === "missing-dynamic-import" && f.file.includes("lazy-chart"),
    );
    expect(staticFindings.length).toBeGreaterThan(0);
    expect(dynamicFindings.length).toBe(0);
  });

  it("does not pull dynamic-only modules into client graph via boundary propagation", async () => {
    const graph = await buildGraph(fixturePath("dynamic-import"));
    const dynamicPage = [...graph.modules.values()].find((m) =>
      m.filePath.includes("app/dynamic/page"),
    );
    expect(dynamicPage?.env).toBe("server");
  });
});
