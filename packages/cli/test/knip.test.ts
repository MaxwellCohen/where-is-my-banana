import { describe, it, expect, vi, beforeEach } from "vitest";
import { runKnipUnusedDependencyAnalysis } from "../src/external/knip.js";

const { mockMain, mockCreateOptions } = vi.hoisted(() => ({
  mockMain: vi.fn(),
  mockCreateOptions: vi.fn(),
}));

vi.mock("knip", () => ({
  main: mockMain,
}));

vi.mock("knip/session", () => ({
  createOptions: mockCreateOptions,
}));

const defaultConfig = {
  thresholds: {} as never,
  ignores: { files: [], rules: [] },
  severityOverrides: {},
};

describe("runKnipUnusedDependencyAnalysis", () => {
  beforeEach(() => {
    mockMain.mockReset();
    mockCreateOptions.mockReset();
    mockCreateOptions.mockResolvedValue({ cwd: "/tmp/project" });
  });

  it("maps knip dependency issues to findings", async () => {
    mockMain.mockResolvedValue({
      issues: {
        dependencies: {
          ".": {
            lodash: {
              type: "dependencies",
              filePath: "package.json",
              workspace: ".",
              symbol: "lodash",
              fixes: [],
              line: 12,
              col: 5,
            },
          },
        },
        devDependencies: {},
      },
    });

    const findings = await runKnipUnusedDependencyAnalysis("/tmp/project", defaultConfig);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("unused-dependency");
    expect(findings[0].source).toBe("knip");
    expect(findings[0].message).toContain("lodash");
    expect(findings[0].loc).toEqual({ line: 12, column: 5 });
  });

  it("includes unused devDependencies", async () => {
    mockMain.mockResolvedValue({
      issues: {
        dependencies: {},
        devDependencies: {
          ".": {
            vitest: {
              type: "devDependencies",
              filePath: "package.json",
              workspace: ".",
              symbol: "vitest",
              fixes: [],
            },
          },
        },
      },
    });

    const findings = await runKnipUnusedDependencyAnalysis("/tmp/project", defaultConfig);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("devDependency");
    expect(findings[0].evidence.field).toBe("devDependencies");
  });

  it("skips packages matching ignores.files patterns", async () => {
    mockMain.mockResolvedValue({
      issues: {
        dependencies: {
          ".": {
            lodash: {
              type: "dependencies",
              filePath: "package.json",
              workspace: ".",
              symbol: "lodash",
              fixes: [],
            },
          },
        },
        devDependencies: {},
      },
    });

    const findings = await runKnipUnusedDependencyAnalysis("/tmp/project", {
      ...defaultConfig,
      ignores: { files: ["lodash"], rules: [] },
    });
    expect(findings).toEqual([]);
  });

  it("returns empty array when knip fails", async () => {
    mockCreateOptions.mockRejectedValue(new Error("no package.json"));
    const findings = await runKnipUnusedDependencyAnalysis("/tmp/project", defaultConfig);
    expect(findings).toEqual([]);
  });
});
