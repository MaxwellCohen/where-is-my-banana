import type { Rule } from "../../types.js";
import { reportFinding, isIgnored, packageInClientGraph } from "../helpers.js";
import { NEXT_BUILTIN_OPTIMIZE } from "../../config.js";

export const missingOptimizePackageImports: Rule = {
  id: "missing-optimize-package-imports",
  category: "config",
  defaultSeverity: "warning",
  run(ctx) {
    const configured = new Set([
      ...NEXT_BUILTIN_OPTIMIZE,
      ...(ctx.nextConfig?.optimizePackageImports ?? []),
    ]);
    for (const pkg of ctx.data.barrelPackages) {
      if (configured.has(pkg)) continue;
      if (!packageInClientGraph(ctx, pkg).length) continue;
      if (isIgnored(ctx, "missing-optimize-package-imports", pkg)) continue;
      reportFinding(ctx, {
          id: `config:missing-optimize-package-imports:${pkg}`,
          ruleId: "missing-optimize-package-imports",
          category: "config",
          defaultSeverity: "warning",
          confidence: "high",
          file: "next.config",
          message: `Add '${pkg}' to experimental.optimizePackageImports`,
          evidence: { package: pkg, files: packageInClientGraph(ctx, pkg) },
          fixStrategy: {
            name: "optimize-imports",
            steps: [
              `Add '${pkg}' to experimental.optimizePackageImports in next.config`,
            ],
          },
        });
    }
  },
};
