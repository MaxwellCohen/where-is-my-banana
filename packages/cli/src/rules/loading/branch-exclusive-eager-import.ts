import { readFileSync } from "node:fs";
import type { Rule } from "../../types.js";
import { analyzeBranchExclusiveComponents } from "../../analysis/branch-exclusive-components.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";
import { relPath } from "../../graph/builder.js";

export const branchExclusiveEagerImport: Rule = {
  id: "branch-exclusive-eager-import",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    const { dynamicImportMinSubtree } = ctx.config.thresholds;

    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      const source = readFileSync(path, "utf-8");
      const candidates = analyzeBranchExclusiveComponents(source, mod.ast(), mod.imports);

      for (const candidate of candidates) {
        const imp = mod.imports.find(
          (i) =>
            !i.isDynamic &&
            !i.isTypeOnly &&
            i.namedSymbols.includes(candidate.componentName),
        );
        if (!imp?.resolvedPath) continue;

        const target = ctx.graph.modules.get(imp.resolvedPath);
        if (!target || target.subtreeBytes < dynamicImportMinSubtree) continue;
        if (isIgnored(ctx, "branch-exclusive-eager-import", path)) continue;

        reportFinding(ctx, {
          id: `${path}:branch-exclusive-eager-import:${candidate.componentName}`,
          ruleId: "branch-exclusive-eager-import",
          category: "loading",
          defaultSeverity: "warning",
          confidence: candidate.pathRootCondition ? "high" : "medium",
          file: path,
          loc: imp.loc,
          message: `'${candidate.componentName}' is only used in one branch of a conditional but statically imported — use next/dynamic`,
          evidence: {
            component: candidate.componentName,
            branch: candidate.branch,
            routes: candidate.routes.length > 0 ? candidate.routes : undefined,
            module: relPath(ctx.projectRoot, imp.resolvedPath),
            subtreeBytes: target.subtreeBytes,
          },
          estimatedBytes: target.subtreeBytes,
          fixStrategy: {
            name: "conditional-dynamic",
            steps: [
              `Replace static import with next/dynamic(() => import('${imp.specifier}'))`,
              "Add a loading fallback for the branch-exclusive component",
            ],
          },
        });
      }
    }
  },
};
