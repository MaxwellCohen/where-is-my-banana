import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAnalyzeExportJsonl } from "../../src/build/analyze-export.js";
import { runBuildAnalysis } from "../../src/build/analyze.js";

const JSONL = [
  JSON.stringify({
    type: "meta",
    schema_version: 1,
    snapshot_name: "wimb",
    module_index_hash: "abc",
    route_count: 2,
    selected_routes: 2,
  }),
  JSON.stringify({
    type: "module",
    ident: "page",
    path: "[project]/app/page.tsx",
    dependencies: { sync: [], async: [], traced: [] },
  }),
  JSON.stringify({
    type: "part",
    route: "/",
    filename: "[client-fs]/static/chunks/app/page.js",
    source_path: "[project]/app/page.tsx",
    size: 1000,
    compressed_size: 800,
  }),
  JSON.stringify({
    type: "part",
    route: "/",
    filename: "[client-fs]/static/chunks/npm.js",
    source_path: "[project]/node_modules/lodash/index.js",
    size: 30_000,
    compressed_size: 24_000,
  }),
  JSON.stringify({
    type: "part",
    route: "/",
    filename: "[server]/app/page.js",
    source_path: "[project]/app/page.tsx",
    size: 5000,
    compressed_size: 2000,
  }),
  JSON.stringify({
    type: "part",
    route: "/about",
    filename: "[client-fs]/static/chunks/about.js",
    source_path: "[project]/node_modules/lodash/index.js",
    size: 1000,
    compressed_size: 600,
  }),
  "",
].join("\n");

describe("parseAnalyzeExportJsonl", () => {
  it("attributes client JS parts and keeps the max module size across routes", () => {
    const attribution = parseAnalyzeExportJsonl(JSONL);

    expect(attribution.measured).toBe(true);
    expect(attribution.format).toBe("export");
    // route totals include server parts: 800 + 24000 + 2000
    expect(attribution.routes.get("/")).toBe(26_800);
    expect(attribution.routes.get("/about")).toBe(600);

    // server part is excluded from the module map
    expect(attribution.modules.get("app/page.tsx")).toBe(800);
    expect(attribution.modules.get("node_modules/lodash/index.js")).toBe(24_000);
    expect(attribution.modules.get("lodash")).toBe(24_000);
  });

  it("ignores blank lines and unknown record types", () => {
    const attribution = parseAnalyzeExportJsonl('\n{"type":"group","route":"/"}\n');
    expect(attribution.measured).toBe(false);
    expect(attribution.routes.size).toBe(0);
  });
});

describe("runBuildAnalysis analyze export file", () => {
  it("reads a gzipped next analyze export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-export-"));
    try {
      const filePath = join(dir, "graph.jsonl.gz");
      writeFileSync(filePath, gzipSync(JSONL));
      const attribution = await runBuildAnalysis({
        projectRoot: dir,
        analyzeExportPath: filePath,
      });
      expect(attribution?.format).toBe("export");
      expect(attribution?.modules.get("lodash")).toBe(24_000);
      expect(attribution?.routes.get("/")).toBe(26_800);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the export file is missing", async () => {
    const attribution = await runBuildAnalysis({
      projectRoot: tmpdir(),
      analyzeExportPath: join(tmpdir(), "does-not-exist-wimb.jsonl"),
    });
    expect(attribution).toBeNull();
  });
});
