import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareReports, writeDiffReport, exitCodeForDiff, toDiffMarkdown } from "../src/diff.js";
import type { ScanReport, WimbConfig } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/config.js";

function report(partial: Partial<ScanReport> & { findings: ScanReport["findings"] }): ScanReport {
  return {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    projectRoot: "/app",
    mode: "source",
    summary: {
      total: partial.findings.length,
      bySeverity: { error: 0, warning: 0, info: 0 },
      byCategory: {},
      estimatedClientBytes: 10_000,
      byteSource: "estimated",
    },
    ...partial,
  };
}

describe("compareReports", () => {
  it("detects new and resolved findings and byte delta", () => {
    const baseline = report({
      summary: {
        total: 1,
        bySeverity: { error: 1, warning: 0, info: 0 },
        byCategory: {},
        estimatedClientBytes: 10_000,
      },
      findings: [
        {
          id: "1",
          ruleId: "heavy-client-import",
          category: "dependency",
          severity: "error",
          confidence: "high",
          file: "app/page.tsx",
          message: "Heavy package 'lodash'",
          evidence: { package: "lodash" },
          estimatedBytes: 10_000,
          fixStrategy: { name: "x", steps: [] },
        },
      ],
    });

    const current = report({
      summary: {
        total: 1,
        bySeverity: { error: 1, warning: 0, info: 0 },
        byCategory: {},
        estimatedClientBytes: 50_000,
      },
      findings: [
        {
          id: "2",
          ruleId: "heavy-client-import",
          category: "dependency",
          severity: "error",
          confidence: "high",
          file: "app/page.tsx",
          message: "Heavy package 'moment'",
          evidence: { package: "moment" },
          estimatedBytes: 50_000,
          fixStrategy: { name: "x", steps: [] },
        },
      ],
    });

    const config: WimbConfig = {
      ...DEFAULT_CONFIG,
      thresholds: { ...DEFAULT_CONFIG.thresholds, diffBudgetBytes: 5_000 },
    };

    const diff = compareReports(baseline, current, config);
    expect(diff.byteDelta).toBe(40_000);
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.newFindings[0].evidence.package).toBe("moment");
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.budgetExceeded).toBe(true);
    expect(exitCodeForDiff(diff, config)).toBe(1);
  });

  it("writes diff reports under .wimb/", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wimb-diff-"));
    const baseline = report({ findings: [] });
    const current = report({
      summary: {
        total: 0,
        bySeverity: { error: 0, warning: 0, info: 0 },
        byCategory: {},
        estimatedClientBytes: 100,
      },
      findings: [],
    });
    const diff = compareReports(baseline, current, DEFAULT_CONFIG);
    writeDiffReport(projectRoot, diff);
    expect(existsSync(join(projectRoot, ".wimb", "wimb-diff.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".wimb", "wimb-diff.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(projectRoot, ".wimb", "wimb-diff.json"), "utf-8")).byteDelta).toBe(
      -9900,
    );
    expect(toDiffMarkdown(diff)).toContain("Byte delta");
  });
});
