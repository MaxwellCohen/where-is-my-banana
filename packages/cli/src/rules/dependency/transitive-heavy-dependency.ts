import type { Module, Rule, RuleContext } from "../../types.js";
import { reportFinding, isProjectSource, projectClientModulePaths, isIgnored, isFrameworkPackage } from "../helpers.js";
import { relPath } from "../../graph/builder.js";

export const transitiveHeavyDependency: Rule = {
  id: "transitive-heavy-dependency",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const { heavyPackageBytes } = ctx.config.thresholds;
    const transitive = collectTransitiveImporters(ctx);
    const directImports = new Set<string>();
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path);
      if (!mod) continue;
      for (const imp of mod.imports) {
        if (imp.packageName) directImports.add(imp.packageName);
      }
    }

    for (const [pkg, size] of ctx.pkg.installSizes) {
      if (isFrameworkPackage(ctx, pkg)) continue;
      const isHeavy = size > heavyPackageBytes || ctx.data.heavyPackages.has(pkg);
      if (!isHeavy) continue;
      if (directImports.has(pkg)) continue;
      const importer = transitive.get(pkg);
      if (!importer) continue;
      if (isIgnored(ctx, "transitive-heavy-dependency", pkg)) continue;

      const chain = importer.importChainFromEntry;
      reportFinding(ctx, {
          id: `pkg:${pkg}:transitive-heavy-dependency`,
          ruleId: "transitive-heavy-dependency",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "medium",
          file: chain[0] ?? importer.filePath,
          message: `Heavy package '${pkg}' reached transitively in client graph`,
          evidence: {
            package: pkg,
            via: relPath(ctx.projectRoot, importer.filePath),
            chain: chain.map((p) => relPath(ctx.projectRoot, p)),
          },
          estimatedBytes: size,
          fixStrategy: {
            name: "fix-transitive",
            steps: [
              "Replace or fork the intermediate dependency",
              "Check replaceable-dependency findings for the intermediate",
            ],
          },
        });
    }
  },
};

/** For each package, the shortest-chain client node_modules module (outside that package) that imports it. */
function collectTransitiveImporters(ctx: RuleContext): Map<string, Module> {
  const result = new Map<string, Module>();
  for (const path of ctx.graph.clientModules) {
    if (isProjectSource(ctx, path)) continue;
    const mod = ctx.graph.modules.get(path);
    if (!mod) continue;
    for (const imp of mod.imports) {
      if (!imp.packageName) continue;
      if (mod.filePath.includes(`/node_modules/${imp.packageName}/`)) continue;
      const prev = result.get(imp.packageName);
      if (!prev || isBetterImporter(mod, prev)) {
        result.set(imp.packageName, mod);
      }
    }
  }
  return result;
}

/** Reachable (non-empty chain) modules beat unreachable ones; then shorter chain; then filePath. */
function isBetterImporter(a: Module, b: Module): boolean {
  const al = a.importChainFromEntry.length;
  const bl = b.importChainFromEntry.length;
  if ((al === 0) !== (bl === 0)) return al !== 0;
  if (al !== bl) return al < bl;
  return a.filePath < b.filePath;
}
