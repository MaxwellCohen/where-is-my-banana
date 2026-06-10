import type { Rule } from "../../types.js";
import { missingOptimizePackageImports } from "./missing-optimize-package-imports.js";
import { legacyBrowserTargets } from "./legacy-browser-targets.js";
import { routeOverBudget } from "./route-over-budget.js";

export const configRules: Rule[] = [
  missingOptimizePackageImports,
  legacyBrowserTargets,
  routeOverBudget,
];
