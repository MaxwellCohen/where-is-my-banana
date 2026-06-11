import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../../types.js";
import { reportFinding, isIgnored } from "../helpers.js";

const LEGACY_PATTERNS = /\bie\b|op_mini|last\s+2\s+versions|>?\s*0\.?\d+%/i;

export const legacyBrowserTargets: Rule = {
  id: "legacy-browser-targets",
  category: "config",
  defaultSeverity: "warning",
  run(ctx) {
    const pkgPath = join(ctx.projectRoot, "package.json");
    const browserslistRc = join(ctx.projectRoot, ".browserslistrc");
    let query = "";
    if (existsSync(browserslistRc)) {
      query = readFileSync(browserslistRc, "utf-8");
    } else {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      query = typeof pkg.browserslist === "string" ? pkg.browserslist : JSON.stringify(pkg.browserslist ?? "");
    }
    if (!query || !LEGACY_PATTERNS.test(query)) return;
    if (isIgnored(ctx, "legacy-browser-targets", "browserslist")) return;
    reportFinding(ctx, {
        id: "config:legacy-browser-targets",
        ruleId: "legacy-browser-targets",
        category: "config",
        defaultSeverity: "warning",
        confidence: "high",
        file: existsSync(browserslistRc) ? ".browserslistrc" : "package.json",
        message: "Legacy browserslist targets inflate transpilation and polyfills",
        evidence: { query },
        fixStrategy: {
          name: "modern-targets",
          steps: [
            "Adopt modern targets (e.g. 'defaults and fully supports es6-module')",
            "Note Next's own default targets",
          ],
        },
      });
  },
};
