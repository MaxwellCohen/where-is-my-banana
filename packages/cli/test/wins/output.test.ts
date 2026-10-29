import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatWinsTerminal, shortPath, writeWins } from "../../src/wins/output.js";
import type { WinsReport } from "../../src/wins/types.js";

const report: WinsReport = {
  version: "2",
  timestamp: "t",
  projectRoot: "/p",
  byteSource: "measured",
  routes: [{ route: "/", firstLoadBytes: 204800 }],
  wins: [
    {
      id: "lazy:a.tsx:chart.tsx",
      fixKind: "lazy",
      safety: "safe",
      safetyReasons: [],
      usage: "conditional-render",
      edge: { importer: "a.tsx", imported: "chart.tsx", packageName: null },
      loc: { line: 3, column: 0 },
      routes: { "/": 51200 },
      totalSavedBytes: 51200,
      byteSource: "measured",
      chain: ["page.tsx", "a.tsx", "chart.tsx"],
      edit: {
        summary: "Lazy-load Chart",
        originalImport: "import Chart from './chart'",
        replacementImport: "const Chart = dynamic(() => import('./chart'))",
        steps: ["do it"],
        verify: "next analyze",
      },
    },
  ],
};

describe("wins output", () => {
  it("formats terminal table", () => {
    const t = formatWinsTerminal(report, { top: 5 });
    expect(t).toContain("200.0 KB");
    expect(t).toContain("50.0");
    expect(t).toContain("a.tsx:3 -> chart.tsx");
    expect(t).toContain("25.0%");
    expect(t).toContain("app");
    expect(t).toContain("lazy");
    expect(t).not.toContain("\t");
  });

  it("shortens pnpm paths", () => {
    const long = "node_modules/.pnpm/next@16.4.0_@babel+core/node_modules/next/dist/client/app-index.js";
    expect(shortPath(long)).toBe("next/dist/client/app-index.js");
    expect(shortPath("src/a.tsx")).toBe("src/a.tsx");
    const s = shortPath(`src/${"x".repeat(100)}.tsx`);
    expect(s).toContain("…");
    expect(s.length).toBe(60);
  });

  it("writes json and md", () => {
    const root = mkdtempSync(join(tmpdir(), "wimb-wins-"));
    writeWins(root, report);
    expect(JSON.parse(readFileSync(join(root, ".wimb/wins.json"), "utf-8"))).toEqual(report);
    const md = readFileSync(join(root, ".wimb/wins.md"), "utf-8");
    expect(md.indexOf("## Top wins")).toBeGreaterThan(-1);
    expect(md).toContain("page.tsx -> a.tsx -> chart.tsx");
    expect(md).toContain("dynamic(() => import('./chart'))");
  });
});
