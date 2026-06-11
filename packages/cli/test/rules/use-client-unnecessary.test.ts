import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { useClientUnnecessary } from "../../src/rules/boundary/use-client-unnecessary.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";
import type { RuleContext, Module } from "../../src/types.js";
import { fixturePath } from "../helpers.js";
import { loadPackageInfo } from "../../src/graph/package-info.js";

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

function makeCtx(filePath: string) {
  const mod: Module = {
    filePath,
    env: "client",
    isBoundary: true,
    directives: new Set(["use client"]),
    imports: [],
    exports: [],
    ast: () => ({ type: "Program", body: [], sourceType: "module" }),
    signals: emptySignals(),
    sourceBytes: 100,
    subtreeBytes: 100,
    importChainFromEntry: [filePath],
    dependents: [],
  };
  const findings: Parameters<RuleContext["report"]>[0][] = [];
  const projectRoot = fixturePath("use-client-unnecessary");
  const ctx: RuleContext = {
    projectRoot,
    graph: {
      modules: new Map([[filePath, mod]]),
      entries: [],
      clientModules: new Set([filePath]),
      serverModules: new Set(),
      sharedModules: new Set(),
    },
    config: DEFAULT_CONFIG,
    pkg: loadPackageInfo(projectRoot),
    data: loadDataTables(),
    nextConfig: null,
    byteAttribution: null,
    report: (f) => findings.push(f),
  };
  return { ctx, findings };
}

describe("use-client-unnecessary", () => {
  it("flags unnecessary use client in project source", () => {
    const filePath = join(fixturePath("use-client-unnecessary"), "app/page.tsx");
    const { ctx, findings } = makeCtx(filePath);
    useClientUnnecessary.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("use-client-unnecessary");
  });

  it("does not flag node_modules files", () => {
    const filePath = join(fixturePath("use-client-unnecessary"), "node_modules/pkg/index.tsx");
    const { ctx, findings } = makeCtx(filePath);
    useClientUnnecessary.run(ctx);
    expect(findings).toHaveLength(0);
  });
});
