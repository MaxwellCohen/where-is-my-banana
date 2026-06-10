import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const localeDataBloat: Rule = {
  id: "locale-data-bloat",
  category: "loading",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        const matches = ctx.data.localePatterns.some((p) => p.test(imp.specifier));
        if (!matches) continue;
        if (isIgnored(ctx, "locale-data-bloat", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:locale-data-bloat`,
            ruleId: "locale-data-bloat",
            category: "loading",
            defaultSeverity: "error",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `Locale/timezone data bloat: '${imp.specifier}'`,
            evidence: { specifier: imp.specifier },
            fixStrategy: {
              name: "lazy-locales",
              steps: [
                "Import only needed locales",
                "Load locale catalogs with dynamic import() keyed by active locale",
                "For timezones use Intl.DateTimeFormat or moment-timezone/builds subsets",
              ],
            },
          }),
        );
      }
    }
  },
};
