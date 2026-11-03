import { describe, expect, it } from "vitest";
import { whyReport } from "../../src/why/index.js";
import { packageTable } from "../../src/wins/packages.js";
import { buildRouteGraph } from "../../src/wins/reach.js";
import { synGraph, type SynMod } from "../helpers-graph.js";

describe("large graph sanity", () => {
  it("50k-node graph: why + package table finish quickly", () => {
    const N = 50_000;
    const mods: Record<string, SynMod> = {};
    const bytes: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const path = i % 5 === 4 ? `node_modules/pkg${i % 97}/f${i}.js` : `src/m${i}.ts`;
      const sync = [2 * i + 1, 2 * i + 2, (i * 7 + 13) % N].filter((j) => j < N && j > i).map((j) => `n${j}`);
      mods[`n${i}`] = { path, sync };
      bytes[path] = 100 + (i % 13);
    }
    const g = synGraph(mods, { "/": { seeds: ["n0"], bytes }, "/b": { seeds: ["n1"], bytes } });
    const t0 = Date.now();
    const rep = whyReport(g, "pkg3", { allRoutes: true });
    const rgs = ["/", "/b"].map((r) => buildRouteGraph(g, r)!);
    const rows = packageTable(rgs);
    const ms = Date.now() - t0;
    expect(rep.routes.length).toBeGreaterThan(0);
    expect(rep.routes[0].chains.length).toBeLessThanOrEqual(3);
    expect(rows.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(8000);
  });
});
