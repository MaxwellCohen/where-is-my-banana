import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAnalyzeBinaryFixture } from "../fixtures/analyze-binary/write-fixture.js";
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
});
