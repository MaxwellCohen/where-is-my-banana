import type { Rule } from "../types.js";
import { boundaryRules } from "./boundary/index.js";
import { dependencyRules } from "./dependency/index.js";
import { misplacementRules } from "./misplacement/index.js";
import { loadingRules } from "./loading/index.js";
import { configRules } from "./config/index.js";

export function getAllRules(): Rule[] {
  return [
    ...boundaryRules,
    ...dependencyRules,
    ...misplacementRules,
    ...loadingRules,
    ...configRules,
  ];
}

export { boundaryRules, dependencyRules, misplacementRules, loadingRules, configRules };
