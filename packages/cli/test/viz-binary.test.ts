import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAnalyzeBinaryFixture } from "./fixtures/analyze-binary/write-fixture.js";
import { buildRouteForestFromBinary } from "../src/viz/binary-forest.js";
import { writeVizGraph } from "../src/viz.js";

describe("buildRouteForestFromBinary", () => {
  it("builds route trees from experimental-analyze fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-bin-viz-"));
    try {
      const dataDir = writeAnalyzeBinaryFixture(dir);
      const viz = buildRouteForestFromBinary(dataDir);
      expect(viz.meta.snapshotName).toBe("experimental-analyze");
      expect(viz.routes.map((r) => r.route).sort()).toEqual(["/", "/about"]);
      expect(viz.trees["/"]?.totalBytes).toBeGreaterThan(0);
      expect(viz.trees["/"]?.children.length).toBeGreaterThan(0);
      // lodash appears under / and has routeCount reflecting usage
      const home = viz.trees["/"]!;
      const flat: string[] = [];
      const walk = (n: (typeof home)["children"][number]) => {
        flat.push(n.label);
        for (const c of n.children) walk(c);
      };
      for (const c of home.children) walk(c);
      expect(flat.some((l) => l === "lodash" || l.includes("lodash"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeVizGraph binary path", () => {
  it("reads --dist-dir style artifacts without analyze-export", () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-viz-dist-"));
    try {
      // Real layout: .next/diagnostics/analyze/data/*
      writeAnalyzeBinaryFixture(join(dir, ".next", "diagnostics", "analyze"));
      const out = join(dir, "bundle-graph.json");
      const viz = writeVizGraph({
        projectRoot: dir,
        distDir: ".next",
        outputPath: out,
      });
      expect(viz.routes.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
