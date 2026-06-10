import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const appBarrelReexport: Rule = {
  id: "app-barrel-reexport",
  category: "boundary",
  defaultSeverity: "warning",
  run(ctx) {
    const { barrelReexportRatio, barrelMinReexports } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (isIgnored(ctx, "app-barrel-reexport", mod.filePath)) continue;
      const reexports = mod.imports.filter(
        (i) => i.namedSymbols.includes("*") || i.specifier.startsWith("."),
      );
      const totalStmts = mod.imports.length + mod.exports.length;
      if (totalStmts === 0) continue;
      if (reexports.length < barrelMinReexports) continue;
      if (reexports.length / totalStmts < barrelReexportRatio) continue;
      const usedByClient = mod.dependents.some((d) => ctx.graph.clientModules.has(d));
      if (!usedByClient) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:app-barrel-reexport`,
          ruleId: "app-barrel-reexport",
          category: "boundary",
          defaultSeverity: "warning",
          confidence: "high",
          file: mod.filePath,
          message: "Barrel file re-exports many modules and is imported by client code",
          evidence: { reexportCount: reexports.length },
          fixStrategy: {
            name: "direct-imports",
            steps: [
              "Change client importers to import from concrete source files",
              "Optionally delete the barrel",
            ],
          },
        }),
      );
    }
  },
};
