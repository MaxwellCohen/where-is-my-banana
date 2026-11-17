import { describe, expect, it } from "vitest";
import { synGraph } from "../helpers-graph.js";
import { attributeRoutes } from "../../src/wins/attribute.js";
import { whyReport } from "../../src/why/index.js";

const edgesFrom = (g: ReturnType<typeof synGraph>, importer: string) =>
  attributeRoutes(g, { minBytes: 1 })[0].edges.filter((e) => e.edge.importer === importer);

describe("import groups", () => {
  it("scores one import that fans out into a side-effect module and a re-export target as one cut", () => {
    // `import { parse } from "yaml"`: Turbopack links the file to the package entry and to the collapsed re-export.
    const g = synGraph(
      {
        page: { path: "app/page.tsx", sync: ["entry", "api"] },
        entry: { path: "node_modules/yaml/index.js", sync: ["core"] },
        api: { path: "node_modules/yaml/dist/public-api.js", sync: ["core"] },
        core: { path: "node_modules/yaml/dist/core.js" },
      },
      {
        "/": {
          seeds: ["page"],
          bytes: { "app/page.tsx": 100, "node_modules/yaml/index.js": 10, "node_modules/yaml/dist/public-api.js": 20, "node_modules/yaml/dist/core.js": 4000 },
        },
      },
    );
    const edges = edgesFrom(g, "app/page.tsx");
    expect(edges).toHaveLength(1);
    expect(edges[0].edge).toEqual({ importer: "app/page.tsx", imported: "node_modules/yaml/index.js", packageName: "yaml" });
    expect(edges[0].uniqueBytes).toBe(4030);
    expect(edges[0].grouped).toBe(true);
    expect(edges[0].alsoReachableVia).toBeUndefined();

    // Both edges are the same import, so `why` shows one chain, not one per edge.
    const { chains } = whyReport(g, "yaml").routes[0];
    expect(chains.map((c) => c.chain)).toEqual([["app/page.tsx", "node_modules/yaml/index.js"]]);
    expect(chains[0].cut!.savedBytes).toBe(4030);
    expect(chains[0].cut!.stillReachableVia).toBeNull();
  });

  it("scores edges to several export parts of one module, on several layers, as one cut", () => {
    // `z.object` + `z.string`: one edge per used export, repeated for the client and SSR layers.
    const z = "node_modules/zod/external.js";
    const g = synGraph(
      {
        proxy: { path: "app/Heavy.tsx", sync: ["client", "ssr"] },
        client: { path: "app/Heavy.tsx", sync: ["objC", "strC"] },
        ssr: { path: "app/Heavy.tsx", sync: ["objS", "strS"] },
        objC: { path: z, sync: ["bodyC"] },
        strC: { path: z, sync: ["bodyC"] },
        objS: { path: z, sync: ["bodyS"] },
        strS: { path: z, sync: ["bodyS"] },
        bodyC: { path: z, sync: ["schemas"] },
        bodyS: { path: z, sync: ["schemas"] },
        schemas: { path: "node_modules/zod/schemas.js" },
      },
      { "/": { seeds: ["proxy"], bytes: { "app/Heavy.tsx": 100, [z]: 50, "node_modules/zod/schemas.js": 3000 } } },
    );
    const edges = edgesFrom(g, "app/Heavy.tsx").filter((e) => e.edge.packageName === "zod");
    expect(edges).toHaveLength(1);
    expect(edges[0].uniqueBytes).toBe(3050);
  });

  it("reports what still keeps the package alive when another file imports it", () => {
    const g = synGraph(
      {
        page: { path: "app/page.tsx", sync: ["a", "b", "other"] },
        a: { path: "node_modules/p/a.js", sync: ["core"] },
        b: { path: "node_modules/p/b.js", sync: ["core"] },
        other: { path: "app/other.tsx", sync: ["a"] },
        core: { path: "node_modules/p/core.js" },
      },
      {
        "/": {
          seeds: ["page"],
          bytes: { "app/page.tsx": 100, "app/other.tsx": 10, "node_modules/p/a.js": 5, "node_modules/p/b.js": 7, "node_modules/p/core.js": 4000 },
        },
      },
    );
    // Only b.js is unique to page.tsx; a.js and core.js stay through other.tsx.
    expect(edgesFrom(g, "app/page.tsx").filter((e) => e.edge.packageName === "p").map((e) => [e.edge.imported, e.uniqueBytes])).toEqual([
      ["node_modules/p/b.js", 7],
    ]);
  });

  it("keeps separate cuts when the single edges already account for every byte", () => {
    const g = synGraph(
      {
        page: { path: "app/page.tsx", sync: ["a", "b"] },
        a: { path: "node_modules/p/a.js" },
        b: { path: "node_modules/p/b.js" },
      },
      { "/": { seeds: ["page"], bytes: { "app/page.tsx": 100, "node_modules/p/a.js": 300, "node_modules/p/b.js": 500 } } },
    );
    const edges = edgesFrom(g, "app/page.tsx");
    expect(edges.map((e) => [e.edge.imported, e.uniqueBytes])).toEqual([
      ["node_modules/p/b.js", 500],
      ["node_modules/p/a.js", 300],
    ]);
    expect(edges.some((e) => e.grouped)).toBe(false);
  });

  it("keeps `why` chains that reach the same import through different files", () => {
    const g = synGraph(
      {
        layout: { path: "app/layout.tsx", sync: ["nav", "page"] },
        nav: { path: "components/Nav.tsx", sync: ["utilC"] },
        page: { path: "app/page.tsx", sync: ["utilS"] },
        // the same file on two bundler layers, each importing yaml
        utilC: { path: "lib/util.ts", sync: ["entry", "api"] },
        utilS: { path: "lib/util.ts", sync: ["entry", "api"] },
        entry: { path: "node_modules/yaml/index.js" },
        api: { path: "node_modules/yaml/dist/public-api.js" },
      },
      { "/": { seeds: ["layout"], bytes: { "app/layout.tsx": 1, "node_modules/yaml/index.js": 10, "node_modules/yaml/dist/public-api.js": 4000 } } },
    );
    expect(whyReport(g, "yaml").routes[0].chains.map((c) => c.chain.slice(0, -1))).toEqual([
      ["app/layout.tsx", "components/Nav.tsx", "lib/util.ts"],
      ["app/layout.tsx", "app/page.tsx", "lib/util.ts"],
    ]);
  });
});
