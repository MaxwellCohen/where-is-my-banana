import type { Rule } from "../../types.js";
import { missingDynamicImport } from "./missing-dynamic-import.js";
import { onDemandFeatureEager } from "./on-demand-feature-eager.js";
import { nextDynamicMisuse } from "./next-dynamic-misuse.js";
import { branchExclusiveEagerImport } from "./branch-exclusive-eager-import.js";
import { staticComponentMap } from "./static-component-map.js";

export const loadingRules: Rule[] = [
  missingDynamicImport,
  branchExclusiveEagerImport,
  staticComponentMap,
  onDemandFeatureEager,
  nextDynamicMisuse,
];
