import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { runE18eAnalysis } from "../src/external/e18e.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("runE18eAnalysis", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps e18e JSON messages to findings", () => {
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({
        messages: [
          {
            ruleId: "duplicate-deps",
            message: "Duplicate dependency lodash",
            severity: "warn",
            filePath: "package.json",
            category: "dependency",
            fixable: true,
          },
        ],
      }),
    );

    const findings = runE18eAnalysis("/tmp/project");
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("e18e:duplicate-deps");
    expect(findings[0].source).toBe("e18e");
    expect(findings[0].severity).toBe("warning");
  });

  it("returns empty array when e18e fails", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("command failed");
    });
    const findings = runE18eAnalysis("/tmp/project");
    expect(findings).toEqual([]);
  });
});
