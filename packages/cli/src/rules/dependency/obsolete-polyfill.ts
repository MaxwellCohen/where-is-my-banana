import type { Rule } from "../../types.js";
import { reportFinding, isIgnored, packageInClientGraph } from "../helpers.js";
import { loadNativeReplacements } from "../../external/module-replacements.js";

export const obsoletePolyfill: Rule = {
  id: "obsolete-polyfill",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const natives = loadNativeReplacements();
    for (const [pkg, native] of natives) {
      const files = packageInClientGraph(ctx, pkg);
      if (!files.length) continue;
      if (isIgnored(ctx, "obsolete-polyfill", pkg)) continue;
      reportFinding(ctx, {
          id: `pkg:${pkg}:obsolete-polyfill`,
          ruleId: "obsolete-polyfill",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: files[0],
          message: `Obsolete polyfill '${pkg}' — use native ${native}`,
          evidence: { package: pkg, nativeApi: native, files },
          fixStrategy: {
            name: "remove-polyfill",
            steps: [`Delete dependency '${pkg}'`, `Use native API: ${native}`],
          },
        });
    }
  },
};
