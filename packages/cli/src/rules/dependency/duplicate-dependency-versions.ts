import type { Rule } from "../../types.js";
import { makeFinding, isIgnored, packageInClientGraph } from "../helpers.js";

export const duplicateDependencyVersions: Rule = {
  id: "duplicate-dependency-versions",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    for (const [pkg, versions] of ctx.pkg.lockfileVersions) {
      if (versions.length <= 1) continue;
      const files = packageInClientGraph(ctx, pkg);
      if (!files.length) continue;
      if (isIgnored(ctx, "duplicate-dependency-versions", pkg)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `pkg:${pkg}:duplicate-dependency-versions`,
          ruleId: "duplicate-dependency-versions",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: files[0],
          message: `Package '${pkg}' resolved to ${versions.length} versions in lockfile`,
          evidence: { package: pkg, versions, files },
          fixStrategy: {
            name: "dedupe-versions",
            steps: [
              "Add overrides/resolutions entry or bump dependencies",
              "Verify a single version resolves",
            ],
          },
        }),
      );
    }
  },
};
