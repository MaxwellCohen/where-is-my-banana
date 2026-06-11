import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildReport, writeReports } from "../src/report/index.js";
import type { Finding } from "../src/types.js";

describe("buildReport", () => {
  it("dedupes estimatedClientBytes by package", () => {
    const findings: Finding[] = [
      {
        id: "1",
        ruleId: "heavy-client-import",
        category: "dependency",
        severity: "error",
        confidence: "high",
        file: "a.tsx",
        message: "a",
        evidence: { package: "lodash" },
        estimatedBytes: 1000,
        fixStrategy: { name: "x", steps: [] },
      },
      {
        id: "2",
        ruleId: "barrel-import",
        category: "dependency",
        severity: "warning",
        confidence: "high",
        file: "b.tsx",
        message: "b",
        evidence: { package: "lodash" },
        estimatedBytes: 800,
        fixStrategy: { name: "x", steps: [] },
      },
    ];

    const report = buildReport("/tmp", "source", findings);
    expect(report.summary.estimatedClientBytes).toBe(1000);
  });
});

describe("writeReports", () => {
  it("writes reports under .wimb/", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wimb-report-"));
    const report = buildReport(projectRoot, "source", []);

    writeReports(projectRoot, report, new Set(["json", "md"]));

    expect(existsSync(join(projectRoot, ".wimb", "wimb-report.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".wimb", "wimb-report.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(projectRoot, ".wimb", "wimb-report.json"), "utf-8")).findings).toEqual(
      [],
    );
  });
});
