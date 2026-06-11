import { describe, it, expect } from "vitest";
import { heavyClientImport } from "../../src/rules/dependency/heavy-client-import.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import type { RuleContext, Module, Import } from "../../src/types.js";
import { fixturePath } from "../helpers.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";

function makeCtx(imports: Import[]): { ctx: RuleContext; findings: ReturnType<RuleContext["report"]> extends void ? never[] : Parameters<RuleContext["report"]>[0][] } {
  const filePath = "/app/components/widget.tsx";
  const mod: Module = {
    filePath,
    env: "client",
    imports,
    exports: [],
    signals: { jsxElements: 1, hooks: 0, eventHandlers: 0, browserApis: 0 },
    sourceBytes: 100,
    subtreeBytes: 100,
    isBoundary: false,
    importChainFromEntry: [],
    directives: [],
  };
  const findings: Parameters<RuleContext["report"]>[0][] = [];
  const installSizes = new Map([["next", 1_000_000], ["lodash", 1_000_000]]);
  const ctx: RuleContext = {
    projectRoot: fixturePath("e2e-app"),
    graph: {
      modules: new Map([[filePath, mod]]),
      entries: [],
      clientModules: new Set([filePath]),
      serverModules: new Set(),
      sharedModules: new Set(),
    },
    config: DEFAULT_CONFIG,
    pkg: { ...loadPackageInfo(fixturePath("e2e-app")), installSizes },
    data: loadDataTables(),
    nextConfig: null,
    byteAttribution: null,
    report: (f) => findings.push(f),
  };
  return { ctx, findings };
}

describe("heavy-client-import", () => {
  it("does not flag next as a heavy import", () => {
    const { ctx, findings } = makeCtx([
      {
        specifier: "next/dynamic",
        resolvedPath: null,
        packageName: "next",
        namedSymbols: ["default"],
        isDynamic: false,
        isTypeOnly: false,
        loc: { line: 1, column: 0 },
      },
    ]);
    heavyClientImport.run(ctx);
    expect(findings).toHaveLength(0);
  });

  it("still flags other large packages", () => {
    const { ctx, findings } = makeCtx([
      {
        specifier: "lodash",
        resolvedPath: null,
        packageName: "lodash",
        namedSymbols: ["default"],
        isDynamic: false,
        isTypeOnly: false,
        loc: { line: 1, column: 0 },
      },
    ]);
    heavyClientImport.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.package).toBe("lodash");
  });
});
