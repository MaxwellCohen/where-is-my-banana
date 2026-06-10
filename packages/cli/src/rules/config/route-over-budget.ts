import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const routeOverBudget: Rule = {
  id: "route-over-budget",
  category: "config",
  defaultSeverity: "error",
  run(ctx) {
    if (!ctx.byteAttribution) return;
    const { routeBudgetBytes } = ctx.config.thresholds;
    for (const [route, bytes] of ctx.byteAttribution.routes) {
      if (bytes <= routeBudgetBytes) continue;
      if (isIgnored(ctx, "route-over-budget", route)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `route:${route}:route-over-budget`,
          ruleId: "route-over-budget",
          category: "config",
          defaultSeverity: "error",
          confidence: "high",
          file: route,
          message: `Route '${route}' exceeds client byte budget (${bytes} > ${routeBudgetBytes})`,
          evidence: { route, bytes, budget: routeBudgetBytes },
          estimatedBytes: bytes,
          fixStrategy: {
            name: "reduce-route-bytes",
            steps: [
              "Review findings for this route sorted by estimatedBytes",
              "Address highest-confidence findings first",
            ],
          },
        }),
      );
    }
  },
};
