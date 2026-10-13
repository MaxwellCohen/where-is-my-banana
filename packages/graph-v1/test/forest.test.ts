import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGraphV1Jsonl } from "../src/parse.js";
import { parseGraphV1File } from "../src/parse-file.js";
import { buildDualRouteForest, buildRouteForest, buildRouteTree } from "../src/forest.js";
import { rankImporters } from "../src/importers.js";
import { isAppSourcePath } from "../src/module-path.js";

const JSONL = [
  JSON.stringify({
    type: "meta",
    schema_version: 1,
    snapshot_name: "wimb-viz",
    module_index_hash: "abc",
    route_count: 2,
    selected_routes: 2,
  }),
  JSON.stringify({
    type: "module",
    ident: "page",
    path: "[project]/app/page.tsx",
    dependencies: { sync: ["chart"], async: ["lazy"], traced: [] },
  }),
  JSON.stringify({
    type: "module",
    ident: "chart",
    path: "[project]/components/chart.tsx",
    dependencies: { sync: ["lodash"], async: [], traced: [] },
  }),
  JSON.stringify({
    type: "module",
    ident: "lodash",
    path: "[project]/node_modules/lodash/index.js",
    dependencies: { sync: [], async: [], traced: [] },
  }),
  JSON.stringify({
    type: "module",
    ident: "lazy",
    path: "[project]/components/lazy.tsx",
    dependencies: { sync: [], async: [], traced: [] },
  }),
  JSON.stringify({
    type: "module",
    ident: "about",
    path: "[project]/app/about/page.tsx",
    dependencies: { sync: ["lodash"], async: [], traced: [] },
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
    type: "route",
    route: "/about",
    entries: [
      {
        route_entry_id: "r1",
        module_ident: "about",
        module_path: "[project]/app/about/page.tsx",
        role: "route",
        entry_kind: "client_bootstrap",
      },
    ],
    coverage: { entries: "exact", groups: "unknown" },
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
    filename: "[client-fs]/static/chunks/chart.js",
    source_path: "[project]/components/chart.tsx",
    size: 2000,
    compressed_size: 1500,
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
    source_path: "[project]/app/about/page.tsx",
    size: 500,
    compressed_size: 400,
  }),
  JSON.stringify({
    type: "part",
    route: "/about",
    filename: "[client-fs]/static/chunks/npm.js",
    source_path: "[project]/node_modules/lodash/index.js",
    size: 1000,
    compressed_size: 600,
  }),
  "",
].join("\n");

describe("parseGraphV1Jsonl", () => {
  it("indexes modules, routes, and client parts only", () => {
    const graph = parseGraphV1Jsonl(JSONL);
    expect(graph.meta?.snapshot_name).toBe("wimb-viz");
    expect(graph.modules.size).toBe(5);
    expect(graph.routes.has("/")).toBe(true);
    expect(graph.clientPartsByRoute.get("/")?.get("app/page.tsx")).toBe(800);
    expect(graph.clientPartsByRoute.get("/")?.has("app/page.tsx")).toBe(true);
    // server parts excluded
    expect(graph.pathRouteUsage.get("node_modules/lodash/index.js")?.size).toBe(2);
  });
});

describe("parseGraphV1File", () => {
  it("reads gzipped exports", () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-graph-"));
    try {
      const filePath = join(dir, "graph.jsonl.gz");
      writeFileSync(filePath, gzipSync(JSONL));
      const graph = parseGraphV1File(filePath);
      expect(graph.modules.get("lodash")?.path).toContain("lodash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildRouteTree", () => {
  it("roots at the route and walks sync imports with bytes + routeCount", () => {
    const graph = parseGraphV1Jsonl(JSONL);
    const tree = buildRouteTree(graph, "/");

    expect(tree.kind).toBe("route");
    expect(tree.label).toBe("/");
    expect(tree.totalBytes).toBe(800 + 1500 + 24_000);
    expect(tree.children).toHaveLength(1);

    const page = tree.children[0]!;
    expect(page.label).toBe("app/page.tsx");
    expect(page.selfBytes).toBe(800);

    const chart = page.children.find((c) => c.label === "components/chart.tsx");
    expect(chart).toBeDefined();
    expect(chart!.selfBytes).toBe(1500);

    const lodash = chart!.children.find((c) => c.label === "lodash");
    expect(lodash).toBeDefined();
    expect(lodash!.selfBytes).toBe(24_000);
    expect(lodash!.routeCount).toBe(2);
  });

  it("omits async deps by default and includes them when requested", () => {
    const graph = parseGraphV1Jsonl(JSONL);
    const syncOnly = buildRouteTree(graph, "/");
    const page = syncOnly.children[0]!;
    expect(page.children.some((c) => c.id === "lazy")).toBe(false);

    const withAsync = buildRouteTree(graph, "/", { includeAsync: true });
    const pageAsync = withAsync.children[0]!;
    expect(pageAsync.children.some((c) => c.id === "lazy")).toBe(true);
  });
});

describe("buildRouteForest", () => {
  it("sorts routes by total client bytes descending", () => {
    const forest = buildRouteForest(parseGraphV1Jsonl(JSONL));
    expect(forest.schemaVersion).toBe(1);
    expect(forest.meta.snapshotName).toBe("wimb-viz");
    expect(forest.routes[0]?.route).toBe("/");
    expect(forest.routes[1]?.route).toBe("/about");
    expect(forest.trees["/"]?.children.length).toBeGreaterThan(0);
    expect(forest.trees["/about"]?.children[0]?.label).toBe("app/about/page.tsx");
  });
});

describe("buildDualRouteForest + importers", () => {
  it("exposes client and server sides and ranks app files by pull weight", () => {
    const dual = buildDualRouteForest(parseGraphV1Jsonl(JSONL));
    expect(dual.schemaVersion).toBe(2);
    expect(dual.sides?.client.routes[0]?.route).toBe("/");
    // server part on / for app/page.tsx is excluded from client, included on server
    expect(dual.sides?.server.trees["/"]?.totalBytes).toBeGreaterThan(0);

    const ranked = rankImporters(dual.sides!.client.trees["/"]!, { appOnly: true });
    expect(ranked[0]?.appFile).toBe(true);
    expect(ranked.some((r) => r.label === "lodash")).toBe(false);
    expect(isAppSourcePath("components/chart.tsx")).toBe(true);
    expect(isAppSourcePath("components/")).toBe(false);
    expect(isAppSourcePath("node_modules/lodash/index.js")).toBe(false);
  });
});

describe("DAG diamond memoization", () => {
  it("expands a shared dependency once and marks later edges shared", () => {
    const diamond = [
      JSON.stringify({
        type: "meta",
        schema_version: 1,
        snapshot_name: "diamond",
        module_index_hash: "d",
        route_count: 1,
        selected_routes: 1,
      }),
      JSON.stringify({
        type: "module",
        ident: "page",
        path: "[project]/app/page.tsx",
        dependencies: { sync: ["a", "b"], async: [], traced: [] },
      }),
      JSON.stringify({
        type: "module",
        ident: "a",
        path: "[project]/a.ts",
        dependencies: { sync: ["shared"], async: [], traced: [] },
      }),
      JSON.stringify({
        type: "module",
        ident: "b",
        path: "[project]/b.ts",
        dependencies: { sync: ["shared"], async: [], traced: [] },
      }),
      JSON.stringify({
        type: "module",
        ident: "shared",
        path: "[project]/shared.ts",
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
        filename: "[client-fs]/static/chunks/x.js",
        source_path: "[project]/shared.ts",
        size: 100,
        compressed_size: 50,
      }),
      "",
    ].join("\n");

    const tree = buildRouteTree(parseGraphV1Jsonl(diamond), "/");
    const page = tree.children[0]!;
    const a = page.children.find((c) => c.id === "a")!;
    const b = page.children.find((c) => c.id === "b")!;
    const sharedUnderA = a.children.find((c) => c.id === "shared");
    const sharedUnderB = b.children.find((c) => c.id === "shared");
    expect(sharedUnderA?.shared).not.toBe(true);
    expect(sharedUnderB?.shared).toBe(true);
  });
});

