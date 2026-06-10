import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const syntaxHighlighterAllLanguages: Rule = {
  id: "syntax-highlighter-all-languages",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        const isFullHljs =
          imp.specifier === "highlight.js" || imp.specifier === "prismjs";
        const isShikiBundle = /shiki/.test(imp.specifier) && !imp.specifier.includes("/");
        if (!isFullHljs && !isShikiBundle) continue;
        if (isIgnored(ctx, "syntax-highlighter-all-languages", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:syntax-highlighter-all-languages`,
            ruleId: "syntax-highlighter-all-languages",
            category: "loading",
            defaultSeverity: "warning",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: "Syntax highlighter imports all languages — use core + registerLanguage",
            evidence: { specifier: imp.specifier },
            fixStrategy: {
              name: "subset-highlighter",
              steps: [
                "Use highlight.js/lib/core + explicit registerLanguage",
                "Or move highlighting server-side",
              ],
            },
          }),
        );
      }
    }
  },
};
