import type { Rule } from "../../types.js";
import { makeFinding, isIgnored, getInstallSize } from "../helpers.js";

export const middlewareHeavyImports: Rule = {
  id: "middleware-heavy-imports",
  category: "misplacement",
  defaultSeverity: "error",
  run(ctx) {
    const { middlewareSourceBytes, middlewarePackageBytes } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (!/middleware\.(t|j)s$/.test(mod.filePath)) continue;
      if (isIgnored(ctx, "middleware-heavy-imports", mod.filePath)) continue;
      let closureBytes = mod.sourceBytes;
      const heavyPkgs: string[] = [];
      for (const imp of mod.imports) {
        if (imp.resolvedPath) {
          const dep = ctx.graph.modules.get(imp.resolvedPath);
          if (dep) closureBytes += dep.sourceBytes;
        }
        if (imp.packageName) {
          const size = getInstallSize(ctx, imp.packageName);
          if (size > middlewarePackageBytes) heavyPkgs.push(imp.packageName);
        }
      }
      if (closureBytes <= middlewareSourceBytes && !heavyPkgs.length) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:middleware-heavy-imports`,
          ruleId: "middleware-heavy-imports",
          category: "misplacement",
          defaultSeverity: "error",
          confidence: "high",
          file: mod.filePath,
          message: "Middleware import closure is too heavy for edge runtime",
          evidence: { closureBytes, heavyPackages: heavyPkgs },
          estimatedBytes: closureBytes,
          fixStrategy: {
            name: "trim-middleware",
            steps: [
              "Trim middleware to edge-safe primitives",
              "Move heavy work into route handlers or layouts",
              "Note Next edge bundle size limits",
            ],
          },
        }),
      );
    }
  },
};
