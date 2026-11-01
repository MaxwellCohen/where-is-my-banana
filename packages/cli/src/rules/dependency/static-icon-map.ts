import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

export const staticIconMap: Rule = {
  id: "static-icon-map",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const { iconMapMinEntries } = ctx.config.thresholds;
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      const iconImports = mod.imports.filter(
        (i) =>
          !i.isTypeOnly &&
          !i.isDynamic &&
          i.packageName &&
          ctx.data.categoryMap.icons?.includes(i.packageName),
      );
      const iconSymbolCount = iconImports.reduce(
        (n, i) => n + i.namedSymbols.filter((sym) => sym && sym !== "*").length,
        0,
      );
      if (iconSymbolCount < iconMapMinEntries) continue;
      if (isIgnored(ctx, "static-icon-map", path)) continue;
      reportFinding(ctx, {
          id: `${path}:static-icon-map`,
          ruleId: "static-icon-map",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: path,
          message: "Large static icon map detected — imports many icon components",
          evidence: { iconImportCount: iconSymbolCount },
          fixStrategy: {
            name: "lazy-icons",
            steps: [
              "Use per-use direct imports",
              "Or a lazy map of dynamic(() => import(...)) entries",
            ],
          },
        });
    }
  },
};
