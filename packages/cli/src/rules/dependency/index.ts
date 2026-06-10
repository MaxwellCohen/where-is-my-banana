import type { Rule } from "../../types.js";
import { replaceableDependency } from "./replaceable-dependency.js";
import { heavyClientImport } from "./heavy-client-import.js";
import { barrelImport } from "./barrel-import.js";
import { obsoletePolyfill } from "./obsolete-polyfill.js";
import { duplicateDependencyCategory } from "./duplicate-dependency-category.js";
import { duplicateDependencyVersions } from "./duplicate-dependency-versions.js";
import { runtimeCssInJs } from "./runtime-css-in-js.js";
import { devCodeInProd } from "./dev-code-in-prod.js";
import { transitiveHeavyDependency } from "./transitive-heavy-dependency.js";
import { unusedDependency } from "./unused-dependency.js";
import { staticIconMap } from "./static-icon-map.js";
import { nodeBuiltinPolyfillConfig } from "./node-builtin-polyfill-config.js";

export const dependencyRules: Rule[] = [
  replaceableDependency,
  heavyClientImport,
  barrelImport,
  obsoletePolyfill,
  duplicateDependencyCategory,
  duplicateDependencyVersions,
  runtimeCssInJs,
  devCodeInProd,
  transitiveHeavyDependency,
  unusedDependency,
  staticIconMap,
  nodeBuiltinPolyfillConfig,
];
