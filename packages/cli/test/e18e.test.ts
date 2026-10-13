import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { runE18eAnalysis, resolveE18eBin } from "../src/external/e18e.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (String(path).includes("@e18e") || String(path).endsWith("/e18e")) return false;
      return actual.existsSync(path);
    }),
  };
});

describe("runE18eAnalysis", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("maps e18e JSON messages to findings", async () => {
    vi.mocked(execFileSync).mockReturnValue(
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

    const findings = await runE18eAnalysis("/tmp/project");
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("e18e:duplicate-deps");
    expect(findings[0].source).toBe("e18e");
    expect(findings[0].severity).toBe("warning");
    expect(execFileSync).toHaveBeenCalled();
  });

  it("returns empty array when e18e fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("command failed");
    });
    const findings = await runE18eAnalysis("/tmp/project");
    expect(findings).toEqual([]);
  });
});

describe("resolveE18eBin", () => {
  it("returns null when not installed", () => {
    expect(resolveE18eBin("/tmp/definitely-missing-wimb-project")).toBeNull();
  });
});
