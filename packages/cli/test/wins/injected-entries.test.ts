import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attributeRoutes } from "../../src/wins/attribute.js";
import { classifyWins } from "../../src/wins/classify.js";
import { collectSeeds } from "../../src/wins/reach.js";
import { synGraph } from "../helpers-graph.js";

let root: string;
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wins-injected-"));
  write("app/page.tsx", `"use client";\nimport { init } from "../components/Sdk";\nexport default function P({ open }: { open: boolean }) { return <main>{open && init()}</main>; }`);
  write("components/Sdk.tsx", `export function init(){ return 1; }`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mods = (extra: Record<string, { path: string; sync?: string[] }> = {}) => ({
  page: { path: "app/page.tsx", sync: ["sdk"] },
  sdk: { path: "components/Sdk.tsx" },
  instr: { path: "instrumentation-client.ts", sync: ["sdk"] },
  ...extra,
});
const bytes = { "app/page.tsx": 100, "components/Sdk.tsx": 40000 };

describe("injected entries", () => {
  it("instrumentation-client is seeded even when not a route entry", () => {
    const g = synGraph(mods(), { "/": { seeds: ["page"], bytes } });
    expect(collectSeeds(g, "/")).toEqual(["page", "instr"]);
  });

  it("server-only instrumentation/middleware are seeded only when client-bundled", () => {
    const m = mods({ mw: { path: "middleware.ts", sync: ["sdk"] }, ins: { path: "src/instrumentation.ts" } });
    const g = synGraph(m, { "/": { seeds: ["page"], bytes: { ...bytes, "src/instrumentation.ts": 10 } } });
    expect(collectSeeds(g, "/")).toEqual(["page", "instr", "ins"]);
  });

  it("a package imported statically by instrumentation-client makes the lazy win static-elsewhere (low confidence)", async () => {
    const g = synGraph(mods(), { "/": { seeds: ["page"], bytes } });
    const attrs = attributeRoutes(g, { minBytes: 1 });
    const cut = attrs[0].edges.find((e) => e.edge.importer === "app/page.tsx" && e.edge.imported === "components/Sdk.tsx")!;
    expect(cut.uniqueBytes).toBe(0);
    expect(cut.alsoReachableVia).toEqual([["instrumentation-client.ts", "components/Sdk.tsx"]]);
    const [w] = await classifyWins(attrs, { projectRoot: root, byteSource: "measured" });
    expect(w.safetyReasons).toContain("static-elsewhere");
    expect(w.confidence).toBe("low");
    expect(w.predictedSavedBytes).toBe(0);
  });

  it("without instrumentation-client the same lazy win keeps its bytes", () => {
    const { instr: _i, ...rest } = mods();
    const g = synGraph(rest, { "/": { seeds: ["page"], bytes } });
    const cut = attributeRoutes(g, { minBytes: 1 })[0].edges.find((e) => e.edge.imported === "components/Sdk.tsx")!;
    expect(cut.uniqueBytes).toBe(40000);
    expect(cut.alsoReachableVia).toBeUndefined();
  });
});
