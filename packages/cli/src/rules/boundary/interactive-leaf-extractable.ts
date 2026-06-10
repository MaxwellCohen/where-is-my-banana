import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const interactiveLeafExtractable: Rule = {
  id: "interactive-leaf-extractable",
  category: "boundary",
  defaultSeverity: "warning",
  run(ctx) {
    const { interactiveLeafRatio } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (!mod.isBoundary) continue;
      if (mod.sourceBytes <= 8192) continue;
      if (isIgnored(ctx, "interactive-leaf-extractable", mod.filePath)) continue;
      const interactive = mod.signals.hooks.length + mod.signals.eventHandlers.length;
      if (!interactive) continue;
      const ratio = interactive / Math.max(mod.sourceBytes / 100, 1);
      if (ratio >= interactiveLeafRatio * 100) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:interactive-leaf-extractable`,
          ruleId: "interactive-leaf-extractable",
          category: "boundary",
          defaultSeverity: "warning",
          confidence: "low",
          file: mod.filePath,
          message: "Large client file with interactive code in a small region — extractable leaf",
          evidence: { sourceBytes: mod.sourceBytes, interactiveSignals: interactive },
          estimatedBytes: mod.sourceBytes,
          fixStrategy: {
            name: "extract-interactive-leaf",
            steps: [
              "Extract the interactive region into a new client component",
              "Remove 'use client' from the parent",
            ],
          },
        }),
      );
    }
  },
};
