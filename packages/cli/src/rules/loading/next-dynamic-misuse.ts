import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const nextDynamicMisuse: Rule = {
  id: "next-dynamic-misuse",
  category: "loading",
  defaultSeverity: "info",
  run(ctx) {
    const { dynamicMisuseMaxSubtree } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (!mod.imports.some((i) => i.isDynamic)) continue;
      for (const imp of mod.imports) {
        if (!imp.isDynamic || !imp.resolvedPath) continue;
        const target = ctx.graph.modules.get(imp.resolvedPath);
        if (target && target.subtreeBytes < dynamicMisuseMaxSubtree) {
          if (isIgnored(ctx, "next-dynamic-misuse", mod.filePath)) continue;
          ctx.report(
            makeFinding(ctx, {
              id: `${mod.filePath}:next-dynamic-misuse:small`,
              ruleId: "next-dynamic-misuse",
              category: "loading",
              defaultSeverity: "info",
              confidence: "high",
              file: mod.filePath,
              loc: imp.loc,
              message: "dynamic() used for a small module — overhead exceeds benefit",
              evidence: { module: imp.resolvedPath, subtreeBytes: target.subtreeBytes },
              fixStrategy: {
                name: "revert-static",
                steps: ["Revert to static import"],
              },
            }),
          );
        }
      }
    }
  },
};
