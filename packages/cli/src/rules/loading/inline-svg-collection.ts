import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

export const inlineSvgCollection: Rule = {
  id: "inline-svg-collection",
  category: "loading",
  defaultSeverity: "info",
  run(ctx) {
    const { inlineSvgMinCount, inlineSvgMinBytes } = ctx.config.thresholds;
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      if (mod.signals.jsxElements < inlineSvgMinCount) continue;
      if (mod.sourceBytes < inlineSvgMinBytes) continue;
      if (isIgnored(ctx, "inline-svg-collection", path)) continue;
      reportFinding(ctx, {
          id: `${path}:inline-svg-collection`,
          ruleId: "inline-svg-collection",
          category: "loading",
          defaultSeverity: "info",
          confidence: "medium",
          file: path,
          message: "Many inline SVG elements increase client bundle size",
          evidence: { jsxElements: mod.signals.jsxElements, sourceBytes: mod.sourceBytes },
          estimatedBytes: mod.sourceBytes,
          fixStrategy: {
            name: "optimize-svgs",
            steps: [
              "Use SVG sprite sheet",
              "Use next/image for static art",
              "Or render SVGs server-side",
            ],
          },
        });
    }
  },
};
