import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRscXrayAnalysis } from "../../src/external/rsc-xray.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const { mockAnalyze } = vi.hoisted(() => ({
  mockAnalyze: vi.fn(),
}));

vi.mock("@rsc-xray/analyzer", () => ({
  analyze: mockAnalyze,
}));

describe("runRscXrayAnalysis", () => {
  beforeEach(() => {
    mockAnalyze.mockReset();
  });

  it("maps unique diagnostics and skips overlapped ones", async () => {
    mockAnalyze.mockResolvedValue({
      diagnostics: [
        {
          ruleId: "server-client-serialization-violation",
          message: "Function prop passed to client",
          severity: "error",
          filePath: "app/page.tsx",
          line: 10,
        },
        {
          ruleId: "duplicate-dependencies",
          message: "lodash duplicated across islands",
          severity: "warn",
          file: "app/layout.tsx",
        },
        {
          ruleId: "client-forbidden-import",
          message: "fs in client — already covered by WIMB",
          severity: "error",
          filePath: "components/x.tsx",
        },
      ],
    });

    const findings = await runRscXrayAnalysis("/tmp/project", DEFAULT_CONFIG);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.ruleId)).toEqual([
      "rsc-xray:server-client-serialization-violation",
      "rsc-xray:duplicate-dependencies",
    ]);
    expect(findings[0].source).toBe("rsc-xray");
    expect(findings[0].severity).toBe("error");
  });

  it("returns empty when analyzer is unavailable", async () => {
    mockAnalyze.mockRejectedValue(new Error("not found"));
    // Also ensure createRequire path fails — the import mock still resolves but analyze throws
    const findings = await runRscXrayAnalysis("/tmp/nope", DEFAULT_CONFIG);
    expect(findings).toEqual([]);
  });
});
