import type { Rule } from "../../types.js";
import { reportFinding, isIgnored, packageInClientGraph } from "../helpers.js";
import { loadReplacements } from "../../external/module-replacements.js";

export const replaceableDependency: Rule = {
  id: "replaceable-dependency",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const replacements = loadReplacements();
    const seen = new Set<string>();
    for (const [pkg, info] of replacements) {
      const files = packageInClientGraph(ctx, pkg);
      if (!files.length || seen.has(pkg)) continue;
      seen.add(pkg);
      if (isIgnored(ctx, "replaceable-dependency", pkg)) continue;
      reportFinding(ctx, {
          id: `pkg:${pkg}:replaceable-dependency`,
          ruleId: "replaceable-dependency",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: files[0],
          message: `Package '${pkg}' has a lighter replacement: ${info.replacement}`,
          evidence: { package: pkg, manifest: info.manifest, docsUrl: info.docsUrl, files },
          fixStrategy: {
            name: "swap-dependency",
            steps: [
              `Review replacement docs: ${info.docsUrl ?? "module-replacements manifest"}`,
              `Run: npx @e18e/cli migrate ${pkg}`,
            ],
          },
        });
    }
  },
};
