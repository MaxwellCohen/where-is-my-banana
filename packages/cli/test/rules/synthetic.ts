import type { Finding, Import, Module, ModuleGraph, RuleContext, Rule } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { loadDataTables } from "../../src/data/index.js";

export const ROOT = "/proj";

export function imp(specifier: string, extra: Partial<Import> = {}): Import {
  const isPkg = !specifier.startsWith(".") && !specifier.startsWith("/");
  const parts = specifier.split("/");
  return {
    specifier,
    resolvedPath: null,
    packageName: isPkg ? (specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!) : null,
    namedSymbols: [],
    isDynamic: false,
    isTypeOnly: false,
    loc: { line: 1, column: 1 },
    ...extra,
  };
}

export function mod(filePath: string, extra: Partial<Module> = {}): Module {
  return {
    filePath,
    env: "client",
    isBoundary: false,
    directives: new Set(),
    imports: [],
    exports: [],
    ast: () => ({ type: "Program", body: [], sourceType: "module" }) as never,
    signals: {
      hooks: [],
      eventHandlers: [],
      browserGlobals: [],
      nodeBuiltins: [],
      envReads: [],
      jsxElements: 0,
      largestLiteralBytes: 0,
      components: [],
      useEffectCalls: [],
    },
    sourceBytes: 100,
    subtreeBytes: 100,
    importChainFromEntry: [filePath],
    dependents: [],
    ...extra,
  };
}

export function run(
  rule: Rule,
  mods: Module[],
  opts: {
    deps?: Record<string, string>;
    installSizes?: Record<string, number>;
    thresholds?: Partial<RuleContext["config"]["thresholds"]>;
  } = {},
): Finding[] {
  const modules = new Map(mods.map((m) => [m.filePath, m]));
  const graph: ModuleGraph = {
    modules,
    entries: mods.length ? [mods[0]!.filePath] : [],
    clientModules: new Set(mods.filter((m) => m.env === "client").map((m) => m.filePath)),
    serverModules: new Set(),
    sharedModules: new Set(),
  };
  const findings: Finding[] = [];
  rule.run({
    projectRoot: ROOT,
    graph,
    config: { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds, ...opts.thresholds } },
    pkg: {
      dependencies: opts.deps ?? {},
      devDependencies: {},
      installSizes: new Map(Object.entries(opts.installSizes ?? {})),
      lockfileVersions: new Map(),
    },
    data: loadDataTables(),
    nextConfig: null,
    byteAttribution: null,
    report: (f) => findings.push(f),
  });
  return findings;
}
