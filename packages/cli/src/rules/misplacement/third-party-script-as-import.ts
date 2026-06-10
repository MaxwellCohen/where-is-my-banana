import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const thirdPartyScriptAsImport: Rule = {
  id: "third-party-script-as-import",
  category: "misplacement",
  defaultSeverity: "warning",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!imp.packageName || !ctx.data.thirdPartyScripts.has(imp.packageName)) continue;
        if (isIgnored(ctx, "third-party-script-as-import", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:third-party-script-as-import`,
            ruleId: "third-party-script-as-import",
            category: "misplacement",
            defaultSeverity: "warning",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `Analytics/tracking '${imp.packageName}' statically imported — use next/script`,
            evidence: { package: imp.packageName },
            fixStrategy: {
              name: "lazy-script",
              steps: [
                "Use @next/third-parties where supported",
                "Otherwise next/script with strategy='lazyOnload' or 'afterInteractive'",
              ],
            },
          }),
        );
      }
    }
  },
};
