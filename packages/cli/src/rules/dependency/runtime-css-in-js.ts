import type { Rule } from "../../types.js";
import { makeFinding, isIgnored, packageInClientGraph } from "../helpers.js";

const CSS_IN_JS = ["styled-components", "@emotion/react", "@emotion/styled"];

export const runtimeCssInJs: Rule = {
  id: "runtime-css-in-js",
  category: "dependency",
  defaultSeverity: "info",
  run(ctx) {
    for (const pkg of CSS_IN_JS) {
      const files = packageInClientGraph(ctx, pkg);
      if (!files.length) continue;
      if (isIgnored(ctx, "runtime-css-in-js", pkg)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `pkg:${pkg}:runtime-css-in-js`,
          ruleId: "runtime-css-in-js",
          category: "dependency",
          defaultSeverity: "info",
          confidence: "high",
          file: files[0],
          message: `Runtime CSS-in-JS '${pkg}' increases client bundle — consider zero-runtime alternatives`,
          evidence: { package: pkg, files },
          fixStrategy: {
            name: "zero-runtime-css",
            steps: [
              "Consider Tailwind, CSS Modules, or vanilla-extract",
              "Low priority — opinionated suggestion",
            ],
          },
        }),
      );
    }
  },
};
