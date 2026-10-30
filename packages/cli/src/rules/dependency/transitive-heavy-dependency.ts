import type { Module, Rule, RuleContext } from "../../types.js";
import { reportFinding, isProjectSource, isIgnored, isFrameworkPackage } from "../helpers.js";
import { relPath } from "../../graph/builder.js";

export const transitiveHeavyDependency: Rule = {
  id: "transitive-heavy-dependency",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const { heavyPackageBytes } = ctx.config.thresholds;
    const transitive = collectTransitiveImporters(ctx);

    for (const [pkg, size] of ctx.pkg.installSizes) {
      if (isFrameworkPackage(ctx, pkg)) continue;
      const isHeavy = size > heavyPackageBytes || ctx.data.heavyPackages.has(pkg);
      if (!isHeavy) continue;
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
      if (
        !prev ||
        mod.importChainFromEntry.length < prev.importChainFromEntry.length ||
        (mod.importChainFromEntry.length === prev.importChainFromEntry.length &&
          mod.filePath < prev.filePath)
      ) {
        result.set(imp.packageName, mod);
      }
    }
  }
  return result;
}
