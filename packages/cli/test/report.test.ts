import { describe, it, expect } from "vitest";
import { buildReport } from "../src/report/index.js";
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
