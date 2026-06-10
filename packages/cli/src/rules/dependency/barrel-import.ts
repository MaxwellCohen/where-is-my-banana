import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const barrelImport: Rule = {
  id: "barrel-import",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!imp.packageName || !ctx.data.barrelPackages.has(imp.packageName)) continue;
        const isDeep = imp.specifier.includes("/") && imp.specifier !== imp.packageName;
        if (isDeep) continue;
        if (isIgnored(ctx, "barrel-import", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:barrel-import:${imp.packageName}`,
            ruleId: "barrel-import",
            category: "dependency",
            defaultSeverity: "warning",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `Barrel import from '${imp.packageName}' — use deep imports or optimizePackageImports`,
            evidence: { specifier: imp.specifier },
            fixStrategy: {
              name: "deep-import",
              steps: [
                `Use deep import path (e.g. ${imp.packageName}/specific-export)`,
                "Or add package to experimental.optimizePackageImports in next.config",
              ],
            },
          }),
        );
      }
    }
  },
};
