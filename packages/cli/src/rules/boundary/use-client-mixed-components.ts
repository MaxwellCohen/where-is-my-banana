import type { Rule } from "../../types.js";
import { isProjectSource, reportFinding, isIgnored } from "../helpers.js";

export const useClientMixedComponents: Rule = {
  id: "use-client-mixed-components",
  category: "boundary",
  defaultSeverity: "warning",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (!isProjectSource(ctx, mod.filePath)) continue;
      if (!mod.isBoundary) continue;
      if (isIgnored(ctx, "use-client-mixed-components", mod.filePath)) continue;
      const comps = mod.signals.components;
      if (comps.length < 2) continue;
      const withSignals = comps.filter((c) => c.signals > 0);
      const withoutSignals = comps.filter((c) => c.signals === 0);
      if (!withSignals.length || !withoutSignals.length) continue;

      reportFinding(ctx, {
          id: `${mod.filePath}:use-client-mixed-components`,
          ruleId: "use-client-mixed-components",
          category: "boundary",
          defaultSeverity: "warning",
          confidence: "high",
          file: mod.filePath,
          message: "Mixed server-safe and interactive components in one client boundary file",
          evidence: {
            components: comps.map((c) => ({ name: c.name, signals: c.signals })),
          },
          fixStrategy: {
            name: "split-components",
            steps: [
              "Move signal-bearing components to a new file with 'use client'",
              "Remove 'use client' from the original file",
              "Update imports/re-exports",
            ],
          },
        });
    }
  },
};
