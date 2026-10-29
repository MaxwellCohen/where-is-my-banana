import type { Rule } from "../../types.js";
import { replaceableDependency } from "./replaceable-dependency.js";
import { heavyClientImport } from "./heavy-client-import.js";
import { barrelImport } from "./barrel-import.js";
import { runtimeCssInJs } from "./runtime-css-in-js.js";
import { transitiveHeavyDependency } from "./transitive-heavy-dependency.js";
import { staticIconMap } from "./static-icon-map.js";

export const dependencyRules: Rule[] = [
  replaceableDependency,
  heavyClientImport,
  barrelImport,
  runtimeCssInJs,
  transitiveHeavyDependency,
  staticIconMap,
];
