import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

const TEST_PATTERNS = [/__mocks__\//, /\.test\./, /\.spec\./, /\.stories\./];

export const devCodeInProd: Rule = {
  id: "dev-code-in-prod",
  category: "dependency",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        const isDevPkg = imp.packageName && ctx.data.devPackages.has(imp.packageName);
        const isTestPath =
          imp.resolvedPath && TEST_PATTERNS.some((p) => p.test(imp.resolvedPath!));
        if (!isDevPkg && !isTestPath) continue;
        if (isIgnored(ctx, "dev-code-in-prod", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:dev-code-in-prod`,
            ruleId: "dev-code-in-prod",
            category: "dependency",
            defaultSeverity: "error",
            confidence: "medium",
            file: path,
            loc: imp.loc,
            message: "Dev/test code imported in client production graph",
            evidence: { specifier: imp.specifier, resolvedPath: imp.resolvedPath },
            fixStrategy: {
              name: "gate-dev-code",
              steps: [
                "Gate behind process.env.NODE_ENV check with dynamic import",
                "Or remove the import entirely",
              ],
            },
          }),
        );
      }
    }
  },
};
