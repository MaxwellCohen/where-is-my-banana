import type { Rule } from "../../types.js";
import { missingDynamicImport } from "./missing-dynamic-import.js";
import { onDemandFeatureEager } from "./on-demand-feature-eager.js";
import { localeDataBloat } from "./locale-data-bloat.js";
import { syntaxHighlighterAllLanguages } from "./syntax-highlighter-all-languages.js";
import { clientSearchIndex } from "./client-search-index.js";
import { largeStaticDataInClient } from "./large-static-data-in-client.js";
import { inlineSvgCollection } from "./inline-svg-collection.js";
import { assetInBundle } from "./asset-in-bundle.js";
import { wasmEagerLoad } from "./wasm-eager-load.js";
import { nextDynamicMisuse } from "./next-dynamic-misuse.js";
import { branchExclusiveEagerImport } from "./branch-exclusive-eager-import.js";
import { staticComponentMap } from "./static-component-map.js";

export const loadingRules: Rule[] = [
  missingDynamicImport,
  branchExclusiveEagerImport,
  staticComponentMap,
  onDemandFeatureEager,
  localeDataBloat,
  syntaxHighlighterAllLanguages,
  clientSearchIndex,
  largeStaticDataInClient,
  inlineSvgCollection,
  assetInBundle,
  wasmEagerLoad,
  nextDynamicMisuse,
];
