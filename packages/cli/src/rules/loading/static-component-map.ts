import { readFileSync } from "node:fs";
import { analyzeComponentRegistries } from "../../analysis/component-registry.js";
import type { Rule, RuleContext } from "../../types.js";
import { isIgnored, isProjectSource, reportFinding } from "../helpers.js";

function isClientRelevant(ctx: RuleContext, filePath: string): boolean {
  const mod = ctx.graph.modules.get(filePath);
  if (!mod) return false;
  if (ctx.graph.clientModules.has(filePath)) return true;
  if (mod.dependents.some((d) => ctx.graph.clientModules.has(d))) return true;
  return mod.imports.some(
    (imp) => imp.resolvedPath && ctx.graph.clientModules.has(imp.resolvedPath),
  );
}

function sumSubtreeBytes(ctx: RuleContext, paths: string[]): number {
  let total = 0;
  for (const path of paths) {
    const target = ctx.graph.modules.get(path);
    if (target) total += target.subtreeBytes;
  }
  return total;
}

export const staticComponentMap: Rule = {
  id: "static-component-map",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    const { componentMapMinEntries, componentMapMinImports } = ctx.config.thresholds;

    for (const mod of ctx.graph.modules.values()) {
      if (!isProjectSource(ctx, mod.filePath)) continue;
      if (!isClientRelevant(ctx, mod.filePath)) continue;
      if (isIgnored(ctx, "static-component-map", mod.filePath)) continue;

      const source = readFileSync(mod.filePath, "utf-8");
      const registries = analyzeComponentRegistries(source, mod.ast(), mod.imports);

      for (const reg of registries) {
        if (reg.componentEntryCount < componentMapMinEntries) continue;
        if (reg.importedComponentCount < componentMapMinImports) continue;

        const subtreeBytes = sumSubtreeBytes(ctx, reg.referencedImportPaths);

        reportFinding(ctx, {
          id: `${mod.filePath}:${reg.exportName}:static-component-map`,
          ruleId: "static-component-map",
          category: "loading",
          defaultSeverity: "warning",
          confidence: "high",
          file: mod.filePath,
          loc: reg.loc,
          message: `Large static component map "${reg.exportName}" eagerly imports ${reg.importedComponentCount} components`,
          evidence: {
            exportName: reg.exportName,
            entryCount: reg.componentEntryCount,
            importedComponentCount: reg.importedComponentCount,
            referencedModules: reg.referencedImportPaths,
            subtreeBytes,
          },
          estimatedBytes: subtreeBytes > 0 ? subtreeBytes : undefined,
          fixStrategy: {
            name: "lazy-component-map",
            steps: [
              "Split the registry into per-feature or per-route maps",
              "Replace static imports with dynamic(() => import('./Component')) per entry",
              "Or pass only the components a page needs instead of one global map",
            ],
          },
        });
      }
    }
  },
};
