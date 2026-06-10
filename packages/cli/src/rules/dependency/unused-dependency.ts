import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const unusedDependency: Rule = {
  id: "unused-dependency",
  category: "dependency",
  defaultSeverity: "info",
  run(ctx) {
    const imported = new Set<string>();
    for (const mod of ctx.graph.modules.values()) {
      for (const imp of mod.imports) {
        if (imp.packageName) imported.add(imp.packageName);
      }
    }
    for (const [name] of Object.entries(ctx.pkg.dependencies)) {
      if (imported.has(name)) continue;
      if (isIgnored(ctx, "unused-dependency", name)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `pkg:${name}:unused-dependency`,
          ruleId: "unused-dependency",
          category: "dependency",
          defaultSeverity: "info",
          confidence: "medium",
          file: "package.json",
          message: `Dependency '${name}' has zero resolved imports`,
          evidence: { package: name },
          fixStrategy: {
            name: "remove-dep",
            steps: [`Remove '${name}' from package.json dependencies`],
          },
        }),
      );
    }
  },
};
