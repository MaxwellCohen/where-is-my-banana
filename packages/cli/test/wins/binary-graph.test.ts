import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { writeAnalyzeBinaryFixture } from "../fixtures/analyze-binary/write-fixture.js";
import { packDataFile, packRouteAnalyzeData } from "../../src/build/binary-format.js";
import { buildGraphFromBinary } from "../../src/wins/binary-graph.js";
import { attributeRoutes } from "../../src/wins/attribute.js";

describe("buildGraphFromBinary", () => {
  it("builds a graph-v1-shaped graph from binary fixtures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-wins-bin-"));
    try {
      const dataDir = writeAnalyzeBinaryFixture(dir);
      const res = await buildGraphFromBinary(dataDir, dir);
      expect(res).not.toBeNull();
      const { graph } = res!;
      expect([...graph.routes.keys()].sort()).toEqual(["/", "/about"]);
      expect(graph.clientPartsByRoute.get("/")?.size).toBeGreaterThan(0);
      const attrs = attributeRoutes(graph, { minBytes: 0 });
      expect(attrs.find((a) => a.route === "/")!.firstLoadBytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes workspace-root paths relative to a monorepo sub-package, so source edges connect", async () => {
    const mono = realpathSync(mkdtempSync(join(tmpdir(), "wimb-wins-bin-mono-")));
    try {
      const web = join(mono, "packages", "web");
      const file = (path: string, content: string | Uint8Array) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      };
      file(join(web, "package.json"), JSON.stringify({ name: "web", dependencies: { lodash: "*" } }));
      file(join(web, "app", "page.tsx"), `import _ from "lodash";\nexport default function Page() { return <p>{_.VERSION}</p>; }\n`);
      file(join(mono, "node_modules", "lodash", "package.json"), JSON.stringify({ name: "lodash", version: "1.0.0", main: "index.js" }));
      file(join(mono, "node_modules", "lodash", "index.js"), "module.exports = { VERSION: '1' };\n");

      // Artifacts as Turbopack writes them for a workspace: rooted at the monorepo, not at packages/web.
      const dataDir = join(web, ".next", "diagnostics", "analyze", "data");
      const page = "[project]/packages/web/app/page.tsx";
      const lodash = "[project]/node_modules/lodash/index.js";
      file(join(dataDir, "modules.data"), packDataFile({ modules: [{ ident: page, path: page }, { ident: lodash, path: lodash }] }));
      writeFileSync(join(dataDir, "routes.json"), JSON.stringify(["/"]));
      writeFileSync(
        join(dataDir, "analyze.data"),
        packRouteAnalyzeData({
          sources: [
            { path: "[project]/" },
            { path: "packages/", parent_source_index: 0 },
            { path: "web/", parent_source_index: 1 },
            { path: "app/", parent_source_index: 2 },
            { path: "page.tsx", parent_source_index: 3 },
            { path: "node_modules/", parent_source_index: 0 },
            { path: "lodash/", parent_source_index: 5 },
            { path: "index.js", parent_source_index: 6 },
          ],
          chunkParts: [
            { source_index: 4, output_file_index: 0, size: 2400, compressed_size: 800 },
            { source_index: 7, output_file_index: 0, size: 72_000, compressed_size: 24_000 },
          ],
          outputFiles: [{ filename: "[client-fs]/static/chunks/app/page.js" }],
          sourceChunkParts: [[], [], [], [], [0], [], [], [1]],
          sourceChildren: [[1, 5], [2], [3], [4], [], [6], [7], []],
          sourceRoots: [0],
        }),
      );

      const { graph, edgeSource } = (await buildGraphFromBinary(dataDir, web))!;
      expect(edgeSource).toBe("source-graph");
      expect([...graph.clientPartsByRoute.get("/")!]).toEqual([
        ["app/page.tsx", 800],
        ["../../node_modules/lodash/index.js", 24_000],
      ]);
      expect([...graph.modules.values()].map((m) => m.path).sort()).toEqual(["../../node_modules/lodash/index.js", "app/page.tsx"]);
      const [edge] = attributeRoutes(graph, { minBytes: 0 })[0].edges;
      expect(edge.edge).toEqual({ importer: "app/page.tsx", imported: "../../node_modules/lodash/index.js", packageName: "lodash" });
      expect(edge.uniqueBytes).toBe(24_000);
    } finally {
      rmSync(mono, { recursive: true, force: true });
    }
  });
});
