import { describe, expect, it } from "vitest";
import { formatFindingsForTerminal } from "../../src/report/terminal.js";
import type { Finding, ScanReport } from "../../src/types.js";

const f = (over: Partial<Finding>): Finding => ({
  id: "1",
  ruleId: "heavy-client-import",
  category: "dependency",
  severity: "error",
  confidence: "high",
  file: "a.tsx",
  message: "too big",
  evidence: {},
  fixStrategy: { name: "x", steps: ["do it"] },
  ...over,
});
const report = (findings: Finding[]) => ({ findings }) as unknown as ScanReport;

describe("formatFindingsForTerminal", () => {
  it("empty report yields empty string", () => {
    expect(formatFindingsForTerminal(report([]))).toBe("");
  });

  it("renders severity, rule, location, bytes, message and first step", () => {
    const out = formatFindingsForTerminal(
      report([f({ loc: { line: 3, column: 1 }, estimatedBytes: 2048 })]),
    );
    expect(out).toContain("error   heavy-client-import  a.tsx:3 (2.0 KB)");
    expect(out).toContain("too big");
    expect(out).toContain("→ do it");
  });

  it("formats MB and B, omits bytes when zero and step when none", () => {
    const out = formatFindingsForTerminal(
      report([
        f({ id: "a", estimatedBytes: 2 * 1_048_576 }),
        f({ id: "b", estimatedBytes: 0, fixStrategy: { name: "x", steps: [] } }),
        f({ id: "c", estimatedBytes: 12 }),
      ]),
    );
    expect(out).toContain("(2.0 MB)");
    expect(out).toContain("(12 B)");
    expect(out.match(/→/g)).toHaveLength(2);
  });
});
