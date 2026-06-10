import { describe, it, expect } from "vitest";
import { buildGraph } from "../../src/graph/builder.js";
import { fixturePath } from "../helpers.js";

describe("graph metrics", () => {
  it("memoizes subtreeBytes as numbers", async () => {
    const graph = await buildGraph(fixturePath("e2e-app"));
    for (const mod of graph.modules.values()) {
      expect(typeof mod.subtreeBytes).toBe("number");
      expect(mod.subtreeBytes).toBeGreaterThanOrEqual(mod.sourceBytes);
    }
  });

  it("stores importChainFromEntry arrays", async () => {
    const graph = await buildGraph(fixturePath("e2e-app"));
    const clientPage = [...graph.modules.values()].find((m) =>
      m.filePath.includes("client-page"),
    );
    expect(Array.isArray(clientPage?.importChainFromEntry)).toBe(true);
    expect(clientPage!.importChainFromEntry.length).toBeGreaterThan(0);
  });
});
