import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWins } from "../../src/wins/index.js";
import type { Win, WinsReport } from "../../src/wins/types.js";

const projectRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/wins-app");
let report: WinsReport;
const find = (importer: string, imported: string): Win | undefined =>
  report.wins.find((w) => w.edge.importer === importer && w.edge.imported === imported);

beforeAll(async () => {
  report = await runWins({ projectRoot, analyzeExportPath: join(projectRoot, "graph.jsonl") });
});

describe("wins e2e (wins-app)", () => {
  it("uses measured bytes and both routes", () => {
    expect(report.byteSource).toBe("measured");
    expect(report.routes.map((r) => r.route).sort()).toEqual(["/", "/dashboard"]);
  });

  it("conditional Chart -> safe lazy, 120000", () => {
    const w = find("app/dashboard/page.tsx", "components/Chart.tsx")!;
    expect(w).toBeDefined();
    expect(w.fixKind).toBe("lazy");
    expect(w.usage).toBe("conditional-render");
    expect(w.safety).toBe("safe");
    expect(w.totalSavedBytes).toBe(120000);
    expect(w.routes).toEqual({ "/dashboard": 120000 });
  });

  it("handler-only xlsx -> safe lazy await import, 200000", () => {
    const w = find("components/ExportButton.tsx", "node_modules/xlsx/xlsx.js")!;
    expect(w).toBeDefined();
    expect(w.fixKind).toBe("lazy");
    expect(w.usage).toBe("event-handler-only");
    expect(w.safety).toBe("safe");
    expect(w.totalSavedBytes).toBe(200000);
    expect(w.edit.replacementImport).toContain("await import('xlsx')");
  });

  it("chain dedupe: ancestor page -> ExportButton dropped in favour of deepest xlsx edge", () => {
    expect(find("app/dashboard/page.tsx", "components/ExportButton.tsx")).toBeUndefined();
  });

  it("barrel lucide-react -> deep-import, 60000", () => {
    const w = find("app/page.tsx", "node_modules/lucide-react/dist/esm/lucide-react.js")!;
    expect(w).toBeDefined();
    expect(w.fixKind).toBe("deep-import");
    expect(w.totalSavedBytes).toBe(60000);
  });

  it("above-the-fold Hero is never safe", () => {
    const w = find("app/page.tsx", "components/Hero.tsx")!;
    expect(w).toBeDefined();
    expect(w.safety).toBe("needs-review");
    expect(w.safetyReasons).toContain("above-the-fold");
    expect(w.totalSavedBytes).toBe(20000);
  });

  it("diamond Shared and next/dynamic Widget are not wins", () => {
    expect(report.wins.some((w) => w.edge.imported === "components/Shared.tsx")).toBe(false);
    expect(report.wins.some((w) => w.edge.imported === "components/Widget.tsx")).toBe(false);
    expect(report.wins.some((w) => w.safety === "safe" && w.edge.imported === "components/Hero.tsx")).toBe(false);
  });
});
