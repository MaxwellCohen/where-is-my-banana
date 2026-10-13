import { describe, it, expect, vi, beforeEach } from "vitest";
import { runKnipUnusedDependencyAnalysis, runKnipAnalysis } from "../src/external/knip.js";
import type { ModuleGraph } from "../src/types.js";

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

function clientGraph(filePath: string): ModuleGraph {
  return {
    modules: new Map(),
    entries: [filePath],
    clientModules: new Set([filePath]),
    serverModules: new Set(),
    sharedModules: new Set(),
  };
}

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

describe("runKnipAnalysis client dead code", () => {
  beforeEach(() => {
    mockMain.mockReset();
    mockCreateOptions.mockReset();
    mockCreateOptions.mockResolvedValue({ cwd: "/tmp/project" });
  });

  it("reports unused exports only for client-reachable modules", async () => {
    mockMain.mockResolvedValue({
      issues: {
        dependencies: {},
        devDependencies: {},
        files: {},
        exports: {
          ".": {
            "components/Dead.tsx": {
              unusedHelper: {
                type: "exports",
                filePath: "components/Dead.tsx",
                workspace: ".",
                symbol: "unusedHelper",
                fixes: [],
                line: 3,
                col: 1,
              },
            },
          },
        },
        types: {},
      },
    });

    const findings = await runKnipAnalysis(
      "/tmp/project",
      defaultConfig,
      clientGraph("/tmp/project/components/Dead.tsx"),
    );
    expect(findings.some((f) => f.ruleId === "unused-client-export")).toBe(true);
    expect(findings.find((f) => f.ruleId === "unused-client-export")?.evidence.export).toBe(
      "unusedHelper",
    );
  });
});
