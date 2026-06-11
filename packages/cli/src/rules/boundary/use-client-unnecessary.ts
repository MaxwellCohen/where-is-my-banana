import type { Rule } from "../../types.js";
import { reportFinding, isIgnored, isProjectSource } from "../helpers.js";
import { isClientOnlyPackage } from "../../graph/builder.js";

export const useClientUnnecessary: Rule = {
  id: "use-client-unnecessary",
  category: "boundary",
  defaultSeverity: "warning",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (!mod.isBoundary) continue;
      if (!isProjectSource(ctx, mod.filePath)) continue;
      if (isIgnored(ctx, "use-client-unnecessary", mod.filePath)) continue;
      const { hooks, eventHandlers, browserGlobals } = mod.signals;
      if (hooks.length || eventHandlers.length || browserGlobals.length) continue;
      const hasClientPkg = mod.imports.some(
        (i) => i.packageName && isClientOnlyPackage(i.packageName, ctx.data),
      );
      if (hasClientPkg) continue;
      const hasReexports = mod.imports.some((i) => i.namedSymbols.includes("*"));
      reportFinding(ctx, {
          id: `${mod.filePath}:use-client-unnecessary`,
          ruleId: "use-client-unnecessary",
          category: "boundary",
          defaultSeverity: "warning",
          confidence: hasReexports ? "medium" : "high",
          file: mod.filePath,
          message: "File has 'use client' but no client signals or client-only dependencies",
          evidence: { importChain: mod.importChainFromEntry },
          fixStrategy: {
            name: "remove-use-client",
            steps: [
              "Delete the 'use client' directive",
              "Run build/typecheck to confirm no descendant needed the boundary",
            ],
          },
        });
    }
  },
};
