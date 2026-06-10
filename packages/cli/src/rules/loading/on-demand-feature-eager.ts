import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const onDemandFeatureEager: Rule = {
  id: "on-demand-feature-eager",
  category: "loading",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!imp.packageName || !ctx.data.onDemandLibs.has(imp.packageName)) continue;
        if (imp.isDynamic) continue;
        if (!mod.signals.eventHandlers.length) continue;
        if (isIgnored(ctx, "on-demand-feature-eager", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:on-demand-feature-eager:${imp.packageName}`,
            ruleId: "on-demand-feature-eager",
            category: "loading",
            defaultSeverity: "error",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `On-demand lib '${imp.packageName}' eagerly imported but only used in handlers`,
            evidence: { package: imp.packageName, eventHandlers: mod.signals.eventHandlers.length },
            fixStrategy: {
              name: "handler-dynamic-import",
              steps: [
                `Replace with await import('${imp.packageName}') inside the event handler`,
              ],
            },
          }),
        );
      }
    }
  },
};
