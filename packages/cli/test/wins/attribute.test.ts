import { describe, expect, it } from "vitest";
import type { GraphModule, ParsedGraph } from "@wimb/graph-v1";
import { attributeRoutes } from "../../src/wins/attribute.js";

function mk(
  deps: Record<string, { sync?: string[]; async?: string[] }>,
  bytes: Record<string, number> | null,
  entry = "a",
): ParsedGraph {
  const modules = new Map<string, GraphModule>();
  for (const [id, d] of Object.entries(deps)) {
    modules.set(id, {
      type: "module",
      ident: id,
      path: `[project]/${id}.js`,
      dependencies: { sync: d.sync ?? [], async: d.async ?? [], traced: [] },
    });
  }
  const parts = bytes ? new Map(Object.entries(bytes).map(([k, v]) => [`${k}.js`, v])) : null;
  return {
    meta: null,
    modules,
    routes: new Map([
      [
        "/",
        {
          type: "route",
          route: "/",
          entries: [{ route_entry_id: "e", module_ident: entry, module_path: `${entry}.js`, role: "route" }],
          coverage: { entries: "exact", groups: "exact" },
        },
      ],
    ]),
    clientPartsByRoute: parts ? new Map([["/", parts]]) : new Map(),
    serverPartsByRoute: new Map(),
    pathRouteUsage: new Map(),
    serverPathRouteUsage: new Map(),
    outputs: [],
    groups: [],
  };
}

const run = (g: ParsedGraph) => attributeRoutes(g, { minBytes: 1 })[0];
const find = (r: ReturnType<typeof run>, i: string, v: string) =>
  r.edges.find((e) => e.edge.importer === `${i}.js` && e.edge.imported === `${v}.js`);

describe("attributeRoutes", () => {
  it("chain", () => {
    const r = run(mk({ a: { sync: ["b"] }, b: { sync: ["c"] }, c: {} }, { a: 10, b: 20, c: 30 }));
    expect(r.firstLoadBytes).toBe(60);
    expect(r.measured).toBe(true);
    const ab = find(r, "a", "b")!;
    expect(ab.uniqueBytes).toBe(50);
    expect(ab.subtreeBytes).toBe(50);
    expect(ab.chain).toEqual(["a.js", "b.js"]);
    expect(find(r, "b", "c")!.chain).toEqual(["a.js", "b.js", "c.js"]);
    expect(r.edges[0].uniqueBytes).toBe(50);
  });

  it("diamond: shared module has 0 unique via either edge", () => {
    const r = run(
      mk({ a: { sync: ["b", "c"] }, b: { sync: ["d"] }, c: { sync: ["d"] }, d: {} }, { a: 1, b: 2, c: 3, d: 100 }),
    );
    expect(find(r, "b", "d")).toBeUndefined();
    expect(find(r, "c", "d")).toBeUndefined();
    expect(find(r, "a", "b")!.uniqueBytes).toBe(2);
    expect(find(r, "a", "b")!.subtreeBytes).toBe(102);
  });

  it("cycle", () => {
    const r = run(mk({ a: { sync: ["b"] }, b: { sync: ["c"] }, c: { sync: ["b"] } }, { a: 1, b: 10, c: 20 }));
    expect(find(r, "a", "b")!.uniqueBytes).toBe(30);
    expect(find(r, "b", "c")!.uniqueBytes).toBe(20);
    expect(find(r, "c", "b")).toBeUndefined();
  });

  it("async edges excluded", () => {
    const r = run(mk({ a: { sync: ["b"], async: ["c"] }, b: {}, c: {} }, { a: 1, b: 5, c: 99 }));
    expect(find(r, "a", "c")).toBeUndefined();
    expect(r.edges).toHaveLength(1);
  });

  it("minBytes default drops small edges", () => {
    const g = mk({ a: { sync: ["b"] }, b: {} }, { a: 1, b: 100 });
    expect(attributeRoutes(g)[0].edges).toEqual([]);
  });

  it("bytes missing", () => {
    const r = run(mk({ a: { sync: ["b"] }, b: {} }, null));
    expect(r.measured).toBe(false);
    expect(r.firstLoadBytes).toBe(0);
    expect(r.edges).toEqual([]);
  });
});
