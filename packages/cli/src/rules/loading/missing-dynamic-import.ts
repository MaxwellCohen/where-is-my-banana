import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const missingDynamicImport: Rule = {
  id: "missing-dynamic-import",
  category: "loading",
  defaultSeverity: "error",
  run(ctx) {
    const { dynamicImportMinSubtree } = ctx.config.thresholds;
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!imp.packageName || !ctx.data.heavyComponents.has(imp.packageName)) continue;
        if (imp.isDynamic) continue;
        if (isIgnored(ctx, "missing-dynamic-import", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:missing-dynamic-import:${imp.packageName}`,
            ruleId: "missing-dynamic-import",
            category: "loading",
            defaultSeverity: "error",
            confidence: "medium",
            file: path,
            loc: imp.loc,
            message: `Heavy component '${imp.packageName}' statically imported — use next/dynamic`,
            evidence: { package: imp.packageName },
            estimatedBytes: mod.subtreeBytes,
            fixStrategy: {
              name: "dynamic-import",
              steps: [
                "Replace with next/dynamic(() => import(...))",
                "Add a loading fallback",
              ],
            },
          }),
        );
      }
      for (const imp of mod.imports) {
        if (!imp.resolvedPath || imp.isDynamic) continue;
        const target = ctx.graph.modules.get(imp.resolvedPath);
        if (!target || target.subtreeBytes <= dynamicImportMinSubtree) continue;
        if (isIgnored(ctx, "missing-dynamic-import", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:missing-dynamic-import:local:${imp.resolvedPath}`,
            ruleId: "missing-dynamic-import",
            category: "loading",
            defaultSeverity: "error",
            confidence: "medium",
            file: path,
            loc: imp.loc,
            message: "Large local module statically imported — candidate for next/dynamic",
            evidence: { module: imp.resolvedPath, subtreeBytes: target.subtreeBytes },
            estimatedBytes: target.subtreeBytes(),
            fixStrategy: {
              name: "conditional-dynamic",
              steps: [
                "Use next/dynamic for conditionally rendered large components",
              ],
            },
          }),
        );
      }
    }
  },
};
