import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeVizGraph } from "../src/viz.js";

const JSONL = [
  JSON.stringify({
    type: "meta",
    schema_version: 1,
    snapshot_name: "cli-viz",
    module_index_hash: "x",
    route_count: 1,
    selected_routes: 1,
  }),
  JSON.stringify({
    type: "module",
    ident: "page",
    path: "[project]/app/page.tsx",
    dependencies: { sync: [], async: [], traced: [] },
  }),
  JSON.stringify({
    type: "route",
    route: "/",
    entries: [
      {
        route_entry_id: "r0",
        module_ident: "page",
        module_path: "[project]/app/page.tsx",
        role: "route",
        entry_kind: "client_bootstrap",
      },
    ],
    coverage: { entries: "exact", groups: "unknown" },
  }),
  JSON.stringify({
    type: "part",
    route: "/",
    filename: "[client-fs]/static/chunks/page.js",
    source_path: "[project]/app/page.tsx",
    size: 1000,
    compressed_size: 700,
  }),
  "",
].join("\n");

describe("writeVizGraph", () => {
  it("writes a schemaVersion 1 forest JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-viz-"));
    try {
      const exportPath = join(dir, "graph.jsonl.gz");
      const outPath = join(dir, "bundle-graph.json");
      writeFileSync(exportPath, gzipSync(JSONL));
      const viz = writeVizGraph({ analyzeExportPath: exportPath, outputPath: outPath });
      expect(viz.schemaVersion).toBe(2);
      expect(viz.sides?.client).toBeDefined();
      expect(viz.sides?.server).toBeDefined();
      expect(viz.routes[0]?.totalBytes).toBe(700);
      const written = JSON.parse(readFileSync(outPath, "utf-8")) as typeof viz;
      expect(written.trees["/"]?.children[0]?.label).toBe("app/page.tsx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
