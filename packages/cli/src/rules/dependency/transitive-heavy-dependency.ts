import type { Rule } from "../../types.js";
import { makeFinding, isIgnored, getInstallSize, isFrameworkPackage } from "../helpers.js";
import { relPath } from "../../graph/builder.js";

export const transitiveHeavyDependency: Rule = {
  id: "transitive-heavy-dependency",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const { heavyPackageBytes } = ctx.config.thresholds;
    const directImports = new Set<string>();
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (imp.packageName) directImports.add(imp.packageName);
      }
    }

    for (const [pkg, size] of ctx.pkg.installSizes) {
      if (isFrameworkPackage(ctx, pkg)) continue;
      const isHeavy = size > heavyPackageBytes || ctx.data.heavyPackages.has(pkg);
      if (!isHeavy) continue;
      const inClient = [...ctx.graph.clientModules].some((p) => {
        const mod = ctx.graph.modules.get(p)!;
        return mod.imports.some((i) => i.packageName === pkg);
      });
      if (!inClient) continue;
      if (directImports.has(pkg)) continue;
      if (isIgnored(ctx, "transitive-heavy-dependency", pkg)) continue;

      const chain = findChain(ctx, pkg);
      ctx.report(
        makeFinding(ctx, {
          id: `pkg:${pkg}:transitive-heavy-dependency`,
          ruleId: "transitive-heavy-dependency",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "medium",
          file: chain[0] ?? pkg,
          message: `Heavy package '${pkg}' reached transitively in client graph`,
          evidence: { package: pkg, chain: chain.map((p) => relPath(ctx.projectRoot, p)) },
          estimatedBytes: size,
          fixStrategy: {
            name: "fix-transitive",
            steps: [
              "Replace or fork the intermediate dependency",
              "Check replaceable-dependency findings for the intermediate",
            ],
          },
        }),
      );
    }
  },
};

function findChain(ctx: { graph: { clientModules: Set<string>; modules: Map<string, { filePath: string; imports: { packageName: string | null; resolvedPath: string | null }[] }> } }, pkg: string): string[] {
  for (const path of ctx.graph.clientModules) {
    const mod = ctx.graph.modules.get(path)!;
    if (mod.imports.some((i) => i.packageName === pkg)) return [mod.filePath];
  }
  return [];
}
