import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWins } from "../../src/wins/index.js";
import type { Win, WinsReport } from "../../src/wins/types.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "../fixtures");
const load = (name: string) => {
  const projectRoot = join(fixtures, name);
  return runWins({ projectRoot, analyzeExportPath: join(projectRoot, "graph.jsonl") });
};
const find = (r: WinsReport, importer: string, imported: string): Win | undefined =>
  r.wins.find((w) => w.edge.importer === importer && w.edge.imported === imported);

describe("wins e2e (wins-preact-app)", () => {
  let report: WinsReport;
  beforeAll(async () => {
    report = await load("wins-preact-app");
  });

  it("ranks HeavyChart then Modal", () => {
    expect(report.wins.map((w) => w.edge.imported)).toEqual(["src/HeavyChart.tsx", "src/Modal.tsx"]);
  });

  it("HeavyChart -> safe lazy from preact/compat", () => {
    const w = find(report, "src/main.tsx", "src/HeavyChart.tsx")!;
    expect(w.fixKind).toBe("lazy");
    expect(w.safety).toBe("safe");
    expect(w.totalSavedBytes).toBe(90000);
    expect(w.edit.replacementImport).toContain("import { lazy } from 'preact/compat';");
    expect(w.edit.replacementImport).toContain("lazy(() => import('./HeavyChart'))");
  });

  it("named Modal needs review with default-shape mapping", () => {
    const w = find(report, "src/main.tsx", "src/Modal.tsx")!;
    expect(w.fixKind).toBe("lazy");
    expect(w.safety).toBe("needs-review");
    expect(w.safetyReasons).toContain("named-export");
    expect(w.edit.replacementImport).toContain("({ default: m.Modal })");
  });
});

describe("wins e2e (wins-namespace-app)", () => {
  let report: WinsReport;
  beforeAll(async () => {
    report = await load("wins-namespace-app");
  });

  it("ranks namespace barrel above conditional report", () => {
    expect(report.wins.map((w) => w.totalSavedBytes)).toEqual([150000, 70000]);
  });

  it("namespace import -> await import, needs-review, never dynamic()", () => {
    const w = find(report, "app/page.tsx", "node_modules/big-icons/index.js")!;
    expect(w.fixKind).toBe("lazy");
    expect(w.safety).toBe("needs-review");
    expect(w.safetyReasons).toContain("unresolved-usage");
    expect(w.edit.replacementImport).toContain("const Icons = await import('big-icons');");
    expect(w.edit.replacementImport).not.toContain("dynamic(");
  });

  it("conditional HeavyReport -> safe next/dynamic (SSR kept)", () => {
    const w = find(report, "app/reports/page.tsx", "components/HeavyReport.tsx")!;
    expect(w.fixKind).toBe("lazy");
    expect(w.safety).toBe("safe");
    expect(w.edit.replacementImport).toContain("import dynamic from 'next/dynamic';");
    expect(w.edit.replacementImport).not.toContain("ssr: false");
  });
});
