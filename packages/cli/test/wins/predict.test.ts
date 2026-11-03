import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attributeRoutes } from "../../src/wins/attribute.js";
import { classifyWins, DYNAMIC_RUNTIME_BYTES } from "../../src/wins/classify.js";
import { checkBudget } from "../../src/wins/compare.js";
import { formatWinsMarkdown, formatWinsTerminal } from "../../src/wins/output.js";
import type { RouteAttribution, WinsReport } from "../../src/wins/types.js";
import { synGraph } from "../helpers-graph.js";

let root: string;
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wins-predict-"));
  write(
    "app/page.tsx",
    `"use client";
import Chart from "../components/Chart";
export default function P({ open }: { open: boolean }) { return <main>{open && <Chart />}</main>; }`,
  );
  write("components/Chart.tsx", `export default function Chart(){ return <div/>; }`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const attr = (bytes: number, extra: Partial<RouteAttribution["edges"][number]> = {}, dyn = false): RouteAttribution => ({
  route: "/",
  firstLoadBytes: 200000,
  measured: true,
  hasDynamicRuntime: dyn,
  edges: [
    {
      edge: { importer: "app/page.tsx", imported: "components/Chart.tsx", packageName: null },
      chain: ["app/page.tsx", "components/Chart.tsx"],
      uniqueBytes: bytes,
      subtreeBytes: bytes,
      ...extra,
    },
  ],
});
const run = (a: RouteAttribution[]) => classifyWins(a, { projectRoot: root, byteSource: "measured" });

describe("attribute: static-elsewhere", () => {
  it("same file reached under another ident keeps it: saves 0, records the chain", () => {
    const g = synGraph(
      {
        page: { path: "app/page.tsx", sync: ["chart1", "wrap"] },
        wrap: { path: "components/Wrap.tsx", sync: ["chart2"] },
        chart1: { path: "components/Chart.tsx" },
        chart2: { path: "components/Chart.tsx" },
      },
      { "/": { seeds: ["page"], bytes: { "app/page.tsx": 100, "components/Wrap.tsx": 100, "components/Chart.tsx": 30000 } } },
    );
    const [r] = attributeRoutes(g, { minBytes: 1 });
    const cut = r.edges.find((e) => e.edge.importer === "app/page.tsx" && e.edge.imported === "components/Chart.tsx")!;
    expect(cut.uniqueBytes).toBe(0);
    expect(cut.alsoReachableVia).toEqual([["app/page.tsx", "components/Wrap.tsx", "components/Chart.tsx"]]);
  });

  it("genuinely unique subtree keeps its bytes and has no alternatives", () => {
    const g = synGraph(
      {
        page: { path: "app/page.tsx", sync: ["chart"] },
        chart: { path: "components/Chart.tsx", sync: ["lib"] },
        lib: { path: "node_modules/big/index.js" },
      },
      { "/": { seeds: ["page"], bytes: { "app/page.tsx": 100, "components/Chart.tsx": 1000, "node_modules/big/index.js": 40000 } } },
    );
    const [r] = attributeRoutes(g, { minBytes: 1 });
    const cut = r.edges.find((e) => e.edge.imported === "components/Chart.tsx")!;
    expect(cut.uniqueBytes).toBe(41000);
    expect(cut.alsoReachableVia).toBeUndefined();
  });

  it("detects next/dynamic runtime already in the route", () => {
    const g = synGraph(
      { page: { path: "app/page.tsx", sync: ["dyn"] }, dyn: { path: "node_modules/next/dist/shared/lib/dynamic.js" } },
      { "/": { seeds: ["page"], bytes: { "app/page.tsx": 100, "node_modules/next/dist/shared/lib/dynamic.js": 500 } } },
    );
    expect(attributeRoutes(g, { minBytes: 1 })[0].hasDynamicRuntime).toBe(true);
  });
});

describe("classify: predicted saving", () => {
  it("unique lazy win stays safe; next/dynamic runtime is subtracted", async () => {
    const [w] = await run([attr(20000)]);
    expect(w.fixKind).toBe("lazy");
    expect(w.safety).toBe("safe");
    expect(w.totalSavedBytes).toBe(20000);
    expect(w.predictedSavedBytes).toBe(20000 - DYNAMIC_RUNTIME_BYTES);
    expect(w.confidence).toBe("medium");
  });

  it("no subtraction when the route already ships dynamic runtime", async () => {
    const [w] = await run([attr(20000, {}, true)]);
    expect(w.predictedSavedBytes).toBe(20000);
  });

  it("tiny prediction -> needs-review net-negative-risk, out of the safe budget", async () => {
    const [w] = await run([attr(3000)]);
    expect(w.predictedSavedBytes).toBe(3000 - DYNAMIC_RUNTIME_BYTES);
    expect(w.safety).toBe("needs-review");
    expect(w.safetyReasons).toContain("net-negative-risk");
    const report: WinsReport = { version: "2", timestamp: "", projectRoot: root, byteSource: "measured", routes: [], wins: [w] };
    expect(checkBudget(report, { maxSafeWinBytes: 0 })).toEqual([]);
  });

  it("statically reachable elsewhere -> predicted 0, static-elsewhere, low confidence, shown in outputs", async () => {
    const via = [["app/layout.tsx", "components/Wrap.tsx", "components/Chart.tsx"]];
    const [w] = await run([attr(0, { alsoReachableVia: via })]);
    expect(w.predictedSavedBytes).toBe(0);
    expect(w.safety).toBe("needs-review");
    expect(w.safetyReasons).toContain("static-elsewhere");
    expect(w.confidence).toBe("low");
    expect(w.alsoReachableVia).toEqual(via);
    const report: WinsReport = { version: "2", timestamp: "", projectRoot: root, byteSource: "measured", routes: [{ route: "/", firstLoadBytes: 200000 }], wins: [w] };
    expect(formatWinsMarkdown(report)).toContain("Also statically reachable via");
    expect(formatWinsMarkdown(report)).toContain("components/Wrap.tsx -> components/Chart.tsx");
    expect(formatWinsTerminal(report)).toContain("also statically reachable via");
  });

  it("old reports without the new fields still format", () => {
    const report = {
      version: "2",
      timestamp: "",
      projectRoot: root,
      byteSource: "measured",
      routes: [{ route: "/", firstLoadBytes: 1000 }],
      wins: [{ id: "x", fixKind: "lazy", safety: "safe", safetyReasons: [], usage: "unknown", edge: { importer: "a", imported: "b", packageName: null }, routes: { "/": 5000 }, totalSavedBytes: 5000, byteSource: "measured", chain: ["a", "b"], edit: { summary: "s", steps: [], verify: "v" } }],
    } as WinsReport;
    expect(formatWinsTerminal(report)).toContain("4.9");
    expect(formatWinsMarkdown(report)).toContain("4.9 KB");
  });
});
