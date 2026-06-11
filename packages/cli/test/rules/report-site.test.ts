import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  isProjectSource,
  makeFinding,
  projectClientModulePaths,
  resolveReportSite,
} from "../../src/rules/helpers.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import { buildGraph } from "../../src/graph/builder.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";
import type { RuleContext, Module } from "../../src/types.js";
import { fixturePath } from "../helpers.js";

function emptySignals(): Module["signals"] {
  return {
    hooks: [],
    eventHandlers: [],
    browserGlobals: [],
    nodeBuiltins: [],
    envReads: [],
    jsxElements: 0,
    largestLiteralBytes: 0,
    components: [],
    useEffectCalls: [],
  };
}

describe("report site attribution", () => {
  const projectRoot = fixturePath("e2e-app");
  const userFile = join(projectRoot, "components/client-page.tsx");
  const nodeModulesFile = join(projectRoot, "node_modules/lodash/index.js");

  function makeCtx(modules: Map<string, Module>): RuleContext {
    const clientModules = new Set(
      [...modules.values()].filter((m) => m.env === "client").map((m) => m.filePath),
    );
    return {
      projectRoot,
      graph: {
        modules,
        entries: [join(projectRoot, "app/page.tsx")],
        clientModules,
        serverModules: new Set(),
        sharedModules: new Set(),
      },
      config: DEFAULT_CONFIG,
      pkg: loadPackageInfo(projectRoot),
      data: loadDataTables(),
      nextConfig: null,
      byteAttribution: null,
      report: () => {},
    };
  }

  it("treats node_modules paths as non-project source", () => {
    const ctx = makeCtx(new Map());
    expect(isProjectSource(ctx, nodeModulesFile)).toBe(false);
    expect(isProjectSource(ctx, userFile)).toBe(true);
  });

  it("resolves node_modules findings to the project importer", () => {
    const userMod: Module = {
      filePath: userFile,
      env: "client",
      isBoundary: true,
      directives: new Set(["use client"]),
      imports: [
        {
          specifier: "lodash",
          resolvedPath: nodeModulesFile,
          packageName: "lodash",
          namedSymbols: ["debounce"],
          isDynamic: false,
          isTypeOnly: false,
          loc: { line: 4, column: 1 },
        },
      ],
      exports: [],
      ast: () => ({ type: "Program", body: [], sourceType: "module" }),
      signals: emptySignals(),
      sourceBytes: 100,
      subtreeBytes: 100,
      importChainFromEntry: [join(projectRoot, "app/page.tsx"), userFile],
      dependents: [],
    };
    const depMod: Module = {
      filePath: nodeModulesFile,
      env: "client",
      isBoundary: false,
      directives: new Set(),
      imports: [],
      exports: [],
      ast: () => ({ type: "Program", body: [], sourceType: "module" }),
      signals: { ...emptySignals(), largestLiteralBytes: 20_000 },
      sourceBytes: 20_000,
      subtreeBytes: 20_000,
      importChainFromEntry: [join(projectRoot, "app/page.tsx"), userFile, nodeModulesFile],
      dependents: [userFile],
    };
    const ctx = makeCtx(
      new Map([
        [userFile, userMod],
        [nodeModulesFile, depMod],
      ]),
    );

    const site = resolveReportSite(ctx, nodeModulesFile);
    expect(site?.file).toBe(userFile);
    expect(site?.loc).toEqual({ line: 4, column: 1 });

    const finding = makeFinding(ctx, {
      id: "test",
      ruleId: "large-static-data-in-client",
      category: "loading",
      defaultSeverity: "warning",
      confidence: "high",
      file: nodeModulesFile,
      message: "Large static data shipped in client module",
      evidence: {},
      fixStrategy: { name: "x", steps: [] },
    });
    expect(finding?.file).toBe("components/client-page.tsx");
    expect(finding?.loc).toEqual({ line: 4, column: 1 });
  });

  it("excludes node_modules from project client module paths", async () => {
    const graph = await buildGraph(fixturePath("e2e-app"));
    const ctx = makeCtx(graph.modules);
    for (const path of projectClientModulePaths(ctx)) {
      expect(isProjectSource(ctx, path)).toBe(true);
    }
  });
});
