import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeEdgeTable,
  packDataFile,
  packRouteAnalyzeData,
} from "../src/build/binary-format.js";
import { rankBinaryImportersByRoute } from "../src/viz/binary-importers.js";

describe("rankBinaryImportersByRoute", () => {
  it("ranks app files by import-graph pull, not path-tree self size", () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-imp-"));
    try {
      const dataDir = join(dir, "data");
      mkdirSync(dataDir, { recursive: true });

      // modules: page -> chart -> lodash
      const modules = [
        { ident: "page", path: "[project]/app/page.tsx" },
        { ident: "chart", path: "[project]/components/chart.tsx" },
        { ident: "lodash", path: "[project]/node_modules/lodash/index.js" },
      ];
      const syncDeps = [[1], [2], []];
      const { ref: depsRef, bytes: depsBytes } = encodeEdgeTable(syncDeps);
      const modulesBuf = packDataFile(
        {
          modules,
          module_dependencies: depsRef,
        },
        depsBytes,
      );
      writeFileSync(join(dataDir, "modules.data"), modulesBuf);
      writeFileSync(join(dataDir, "routes.json"), JSON.stringify(["/"]));

      // Route attribution: page 100, chart 200, lodash 20000 (client)
      const routeBuf = packRouteAnalyzeData({
        sources: [
          { path: "[project]/" },
          { path: "app/", parent_source_index: 0 },
          { path: "page.tsx", parent_source_index: 1 },
          { path: "components/", parent_source_index: 0 },
          { path: "chart.tsx", parent_source_index: 3 },
          { path: "node_modules/", parent_source_index: 0 },
          { path: "lodash/", parent_source_index: 5 },
          { path: "index.js", parent_source_index: 6 },
        ],
        chunkParts: [
          { source_index: 2, output_file_index: 0, size: 200, compressed_size: 100 },
          { source_index: 4, output_file_index: 0, size: 400, compressed_size: 200 },
          { source_index: 7, output_file_index: 0, size: 40_000, compressed_size: 20_000 },
        ],
        outputFiles: [{ filename: "[client-fs]/static/chunks/app.js" }],
        sourceChunkParts: [[], [], [0], [], [1], [], [], [2]],
        sourceChildren: [[1, 3, 5], [2], [], [4], [], [6], [7], []],
        sourceRoots: [0],
      });
      writeFileSync(join(dataDir, "analyze.data"), routeBuf);

      const ranked = rankBinaryImportersByRoute(dataDir, "client");
      const rows = ranked["/"] ?? [];
      expect(rows.length).toBeGreaterThanOrEqual(2);

      const page = rows.find((r) => r.path === "app/page.tsx");
      const chart = rows.find((r) => r.path === "components/chart.tsx");
      expect(page).toBeDefined();
      expect(chart).toBeDefined();
      // page pulls chart + lodash
      expect(page!.pullBytes).toBe(100 + 200 + 20_000);
      expect(page!.selfBytes).toBe(100);
      expect(page!.topDeps?.[0]?.label).toBe("lodash");
      expect(page!.badges?.sync).toBe(1);
      expect(page!.badges?.async).toBe(0);
      expect(page!.badges?.modules).toBe(3);
      expect(page!.topDeps?.[0]?.reach).toBe("sync");
      expect(page!.topDeps?.[0]?.kind).toBe("package");
      // chart pulls lodash
      expect(chart!.pullBytes).toBe(200 + 20_000);
      expect(chart!.pullBytes).toBeGreaterThan(chart!.selfBytes);
      // Sorted by pull descending
      expect(rows[0]!.pullBytes).toBeGreaterThanOrEqual(rows[1]!.pullBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
