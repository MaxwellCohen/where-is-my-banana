import type { Rule } from "../../types.js";
import { reportFinding, isIgnored, packageInClientGraph } from "../helpers.js";

export const duplicateDependencyCategory: Rule = {
  id: "duplicate-dependency-category",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    for (const [category, packages] of Object.entries(ctx.data.categoryMap)) {
      const present = packages.filter((p) => packageInClientGraph(ctx, p).length > 0);
      if (present.length < 2) continue;
      if (isIgnored(ctx, "duplicate-dependency-category", category)) continue;
      reportFinding(ctx, {
          id: `category:${category}:duplicate-dependency-category`,
          ruleId: "duplicate-dependency-category",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: packageInClientGraph(ctx, present[0])[0],
          message: `Multiple ${category} libraries in client graph: ${present.join(", ")}`,
          evidence: {
            category,
            packages: present.map((p) => ({ name: p, files: packageInClientGraph(ctx, p) })),
          },
          fixStrategy: {
            name: "consolidate-deps",
            steps: [
              "Consolidate on the package with more usages or the lighter one",
              "Migrate call sites",
            ],
          },
        });
    }
  },
};
