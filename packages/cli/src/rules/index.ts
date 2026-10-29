import type { Rule } from "../types.js";
import { boundaryRules } from "./boundary/index.js";
import { dependencyRules } from "./dependency/index.js";
import { loadingRules } from "./loading/index.js";

export function getAllRules(): Rule[] {
  return [...boundaryRules, ...dependencyRules, ...loadingRules];
}

export { boundaryRules, dependencyRules, loadingRules };
