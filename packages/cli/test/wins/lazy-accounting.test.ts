import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphModule, ParsedGraph } from "@wimb/graph-v1";
import { buildRouteGraph } from "../../src/wins/reach.js";
import { accountLazy } from "../../src/wins/lazy.js";
import { findBarrelDefeats } from "../../src/wins/barrels.js";
import { packageTable } from "../../src/wins/packages.js";
import { attributeRoutes } from "../../src/wins/attribute.js";
import { classifyWins } from "../../src/wins/classify.js";
import { compareWins } from "../../src/wins/compare.js";
import { formatWinsMarkdown, formatWinsTerminal } from "../../src/wins/output.js";
import { buildGraphFromBinary } from "../../src/wins/binary-graph.js";
import { packDataFile, packRouteAnalyzeData } from "../../src/build/binary-format.js";
import type { WinsReport } from "../../src/wins/types.js";

type Dep = { sync?: string[]; async?: string[] };
function mk(deps: Record<string, Dep>, bytes: Record<string, number>, entry: string): ParsedGraph {
  const modules = new Map<string, GraphModule>();
  for (const [p, d] of Object.entries(deps)) {
    modules.set(p, { type: "module", ident: p, path: `[project]/${p}`, dependencies: { sync: d.sync ?? [], async: d.async ?? [], traced: [] } });
  }
  return {
    meta: null,
    modules,
    routes: new Map([["/", { type: "route", route: "/", entries: [{ route_entry_id: "e", module_ident: entry, module_path: entry, role: "route", entry_kind: "client_bootstrap" }], coverage: { entries: "exact", groups: "exact" } }]]),
    clientPartsByRoute: new Map([["/", new Map(Object.entries(bytes))]]),
    serverPartsByRoute: new Map(),
    pathRouteUsage: new Map(),
    serverPathRouteUsage: new Map(),
    outputs: [],
    groups: [],
  };
}

let root: string;
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wimb-lazy-"));
  write(
    "app/page.tsx",
    `"use client";
import dynamic from "next/dynamic";
import Chart from "../components/Chart";
const Always = dynamic(() => import("../components/Always"));
const Modal = dynamic(() => import("../components/Modal"));
const Client = dynamic(() => import("../components/ClientOnly"), { ssr: false });
export default function P({ open }: { open: boolean }) {
  return <main><Chart /><Always />{open && <Modal />}<Client /></main>;
}
export async function load() { return import("../components/Handler"); }
`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const graph = () =>
  mk(
    {
      "app/page.tsx": { sync: ["components/Chart.tsx"], async: ["components/Always.tsx", "components/Modal.tsx", "components/ClientOnly.tsx", "components/Handler.tsx"] },
      "components/Chart.tsx": {},
      "components/Always.tsx": { sync: ["components/AlwaysDep.tsx"] },
      "components/AlwaysDep.tsx": {},
      "components/Modal.tsx": {},
      "components/ClientOnly.tsx": {},
      "components/Handler.tsx": {},
    },
    { "app/page.tsx": 1000, "components/Chart.tsx": 5000, "components/Always.tsx": 3000, "components/AlwaysDep.tsx": 2000, "components/Modal.tsx": 4000, "components/ClientOnly.tsx": 700, "components/Handler.tsx": 300 },
    "app/page.tsx",
  );

describe("lazy accounting", () => {
  it("excludes dynamic-only chunks from first-load", () => {
    const rg = buildRouteGraph(graph(), "/")!;
    expect(rg.firstLoadBytes).toBe(6000);
    expect(attributeRoutes(graph(), { minBytes: 0 })[0]!.firstLoadBytes).toBe(6000);
  });

  it("splits preloaded vs on-demand using server-render usage", async () => {
    const acc = await accountLazy(buildRouteGraph(graph(), "/")!, root);
    expect(acc.preloadedBytes).toBe(5000); // Always + its static dep
    expect(acc.onDemandBytes).toBe(4000 + 700 + 300); // conditional, ssr:false, bare import() in handler
    const byName = Object.fromEntries(acc.edges.map((e) => [e.imported.split("/").pop(), e.kind]));
    expect(byName).toMatchObject({ "Always.tsx": "preloaded", "Modal.tsx": "on-demand", "ClientOnly.tsx": "on-demand", "Handler.tsx": "on-demand" });
  });

  it("treats a target that is also statically imported as no dynamic chunk", () => {
    const g = mk({ "a.tsx": { sync: ["b.tsx"], async: ["b.tsx"] }, "b.tsx": {} }, { "a.tsx": 100, "b.tsx": 900 }, "a.tsx");
    const rg = buildRouteGraph(g, "/")!;
    expect(rg.firstLoadBytes).toBe(1000);
    expect(rg.dynamicRefs.map((r) => r.alsoStatic)).toEqual([true]);
  });

  it("binary graph does not seed async-only modules as first-load", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wimb-lazy-bin-")));
    try {
      const dataDir = join(dir, "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "modules.data"), packDataFile({ modules: [{ ident: "[project]/app/page.tsx", path: "[project]/app/page.tsx" }, { ident: "[project]/components/Lazy.tsx", path: "[project]/components/Lazy.tsx" }] }));
      writeFileSync(join(dataDir, "routes.json"), JSON.stringify(["/"]));
      writeFileSync(
        join(dataDir, "analyze.data"),
        packRouteAnalyzeData({
          sources: [{ path: "[project]/" }, { path: "app/", parent_source_index: 0 }, { path: "page.tsx", parent_source_index: 1 }, { path: "components/", parent_source_index: 0 }, { path: "Lazy.tsx", parent_source_index: 3 }],
          chunkParts: [
            { source_index: 2, output_file_index: 0, size: 2400, compressed_size: 800 },
            { source_index: 4, output_file_index: 0, size: 30000, compressed_size: 10000 },
          ],
          outputFiles: [{ filename: "[client-fs]/static/chunks/app/page.js" }],
          sourceChunkParts: [[], [], [0], [], [1]],
          sourceChildren: [[1, 3], [2], [], [4], []],
          sourceRoots: [0],
        }),
      );
      mkdirSync(join(dir, "app"), { recursive: true });
      mkdirSync(join(dir, "components"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }));
      writeFileSync(join(dir, "components/Lazy.tsx"), `export default function Lazy(){ return null; }\n`);
      writeFileSync(join(dir, "app/page.tsx"), `export const l = () => import("../components/Lazy");\n`);
      const res = await buildGraphFromBinary(dataDir, dir);
      const rg = buildRouteGraph(res!.graph, "/")!;
      expect(rg.firstLoadBytes).toBe(800);
      expect(rg.dynamicRefs.some((r) => r.imported === "components/Lazy.tsx" && !r.alsoStatic && r.bytes === 10000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lazy win on an always-rendered component says it moves bytes to preloaded", async () => {
    const atts = [{ route: "/", firstLoadBytes: 50000, measured: true, edges: [{ edge: { importer: "app/always.tsx", imported: "components/Chart.tsx", packageName: null }, chain: ["app/always.tsx", "components/Chart.tsx"], uniqueBytes: 20000, subtreeBytes: 20000 }] }];
    write("app/always.tsx", `import Chart from "../components/Chart";\nexport default function P(){ return <main><Chart /></main>; }\n`);
    write("components/Chart.tsx", `export default function Chart(){ return <div/>; }\n`);
    const [w] = await classifyWins(atts, { projectRoot: root, byteSource: "measured", framework: "next" });
    expect(w!.fixKind).toBe("lazy");
    expect(w!.movesToPreloadedBytes).toBe(20000);
    expect(w!.edit.summary).toContain("moves 19.5 KB from first-load to preloaded; real saving only if the component is conditional");
  });
});

describe("compare + output with preloaded", () => {
  const rep = (fl: number, pre?: number): WinsReport => ({ version: "2", timestamp: "", projectRoot: "/", byteSource: "measured", routes: [{ route: "/", firstLoadBytes: fl, ...(pre !== undefined ? { preloadedBytes: pre, onDemandBytes: 10 } : {}) }], wins: [] });
  it("computes preloaded deltas and stays back-compat", () => {
    expect(compareWins(rep(100, 10), rep(60, 50)).routes[0]).toMatchObject({ delta: -40, preloadedDelta: 40 });
    expect(compareWins(rep(100), rep(60)).routes[0]!.preloadedDelta).toBeUndefined();
  });
  it("prints both numbers", () => {
    const r = rep(2048, 1024);
    expect(formatWinsMarkdown(r)).toContain("| / | 2.0 | 1.0 | 0.0 |");
    expect(formatWinsTerminal(r)).toContain("1.0 KB preloaded");
  });
});

describe("package table", () => {
  it("ranks packages with pct, routes and top first-party importer", () => {
    const g = mk(
      {
        "app/page.tsx": { sync: ["components/Chart.tsx", "components/Table.tsx"] },
        "components/Chart.tsx": { sync: ["node_modules/recharts/index.js"] },
        "components/Table.tsx": { sync: ["node_modules/tiny/index.js"] },
        "node_modules/recharts/index.js": { sync: ["node_modules/recharts/dep.js"] },
        "node_modules/recharts/dep.js": {},
        "node_modules/tiny/index.js": {},
      },
      { "app/page.tsx": 1000, "components/Chart.tsx": 500, "components/Table.tsx": 500, "node_modules/recharts/index.js": 6000, "node_modules/recharts/dep.js": 2000, "node_modules/tiny/index.js": 100 },
      "app/page.tsx",
    );
    const rows = packageTable([buildRouteGraph(g, "/")!]);
    expect(rows[0]).toMatchObject({ package: "recharts", bytes: 8000, routes: 1, topImporter: "components/Chart.tsx" });
    expect(rows[0]!.pct).toBeCloseTo(79.2, 1);
    expect(rows[1]!.package).toBe("tiny");
  });
});

describe("barrels that defeat lazy loading", () => {
  it("flags an already-lazy target still imported through a barrel, with importer lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wimb-barrel-"));
    try {
      const w = (rel: string, src: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), src);
      };
      w("components/index.tsx", `export * from "./Chart";\nexport { Table } from "./Table";\nexport { default as Card } from "./Card";\n`);
      w("components/Chart.tsx", `export function Chart(){ return null; }\n`);
      w("components/Table.tsx", `export function Table(){ return null; }\n`);
      w("components/Card.tsx", `export default function Card(){ return null; }\n`);
      w("app/page.tsx", `import dynamic from "next/dynamic";\nimport { Table } from "../components";\nconst Chart = dynamic(() => import("../components/Chart").then((m) => m.Chart));\nexport default function P(){ return <><Table /><Chart /></>; }\n`);
      const g = mk(
        {
          "app/page.tsx": { sync: ["components/index.tsx"], async: ["components/Chart.tsx"] },
          "components/index.tsx": { sync: ["components/Chart.tsx", "components/Table.tsx", "components/Card.tsx"] },
          "components/Chart.tsx": {},
          "components/Table.tsx": {},
          "components/Card.tsx": {},
        },
        { "app/page.tsx": 100, "components/index.tsx": 10, "components/Chart.tsx": 9000, "components/Table.tsx": 500, "components/Card.tsx": 500 },
        "app/page.tsx",
      );
      const rg = buildRouteGraph(g, "/")!;
      const found = await findBarrelDefeats([rg], [], dir);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: "already-lazy", target: "components/Chart.tsx", barrel: "components/index.tsx", importers: [{ file: "app/page.tsx", line: 2 }] });
      expect(formatWinsMarkdown({ version: "2", timestamp: "", projectRoot: dir, byteSource: "measured", routes: [], wins: [], barrels: found })).toContain("Barrels that defeat lazy loading");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
