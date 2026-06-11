import type { Rule } from "../../types.js";
import { isProjectSource, reportFinding, isIgnored } from "../helpers.js";

export const missingPoisonPill: Rule = {
  id: "missing-poison-pill",
  category: "boundary",
  defaultSeverity: "info",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (!isProjectSource(ctx, mod.filePath)) continue;
      if (isIgnored(ctx, "missing-poison-pill", mod.filePath)) continue;
      const hasServerSignals =
        mod.signals.nodeBuiltins.length > 0 ||
        mod.imports.some((i) => i.packageName && ctx.data.serverPackages.has(i.packageName));
      if (
        !ctx.graph.clientModules.has(mod.filePath) &&
        hasServerSignals &&
        !mod.directives.has("server-only")
      ) {
        reportFinding(ctx, {
            id: `${mod.filePath}:missing-poison-pill:server`,
            ruleId: "missing-poison-pill",
            category: "boundary",
            defaultSeverity: "info",
            confidence: "high",
            file: mod.filePath,
            message: "Server-only module missing 'server-only' import",
            evidence: { nodeBuiltins: mod.signals.nodeBuiltins.length },
            fixStrategy: {
              name: "add-server-only",
              steps: ["Add import 'server-only' as the first import"],
            },
          });
      }
      if (
        mod.signals.browserGlobals.length > 0 &&
        mod.env === "server" &&
        !mod.directives.has("client-only")
      ) {
        reportFinding(ctx, {
            id: `${mod.filePath}:missing-poison-pill:client`,
            ruleId: "missing-poison-pill",
            category: "boundary",
            defaultSeverity: "info",
            confidence: "high",
            file: mod.filePath,
            message: "Browser globals at top-level in server module — consider 'client-only'",
            evidence: {},
            fixStrategy: {
              name: "add-client-only",
              steps: ["Add import 'client-only' as the first import"],
            },
          });
      }
    }
  },
};
