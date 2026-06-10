import type { Rule } from "../../types.js";
import { makeFinding, isIgnored, estimatedBytes } from "../helpers.js";

export const heavyClientImport: Rule = {
  id: "heavy-client-import",
  category: "dependency",
  defaultSeverity: "error",
  run(ctx) {
    const { heavyPackageBytes } = ctx.config.thresholds;
    const seen = new Set<string>();
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!imp.packageName || seen.has(`${path}:${imp.packageName}`)) continue;
        const size = estimatedBytes(ctx, imp.packageName);
        const isHeavy =
          size > heavyPackageBytes || ctx.data.heavyPackages.has(imp.packageName);
        if (!isHeavy) continue;
        seen.add(`${path}:${imp.packageName}`);
        if (isIgnored(ctx, "heavy-client-import", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:heavy-client-import:${imp.packageName}`,
            ruleId: "heavy-client-import",
            category: "dependency",
            defaultSeverity: "error",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `Heavy package '${imp.packageName}' imported in client graph`,
            evidence: { package: imp.packageName, importChain: mod.importChainFromEntry() },
            estimatedBytes: size,
            fixStrategy: {
              name: "reduce-heavy-import",
              steps: [
                "Use a lighter alternative if available",
                "Move usage server-side",
                "Or use next/dynamic for on-demand loading",
              ],
            },
          }),
        );
      }
    }
  },
};
