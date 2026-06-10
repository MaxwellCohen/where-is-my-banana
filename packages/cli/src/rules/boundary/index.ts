import type { Rule } from "../../types.js";
import { useClientUnnecessary } from "./use-client-unnecessary.js";
import { useClientTooHigh } from "./use-client-too-high.js";
import { useClientMixedComponents } from "./use-client-mixed-components.js";
import { interactiveLeafExtractable } from "./interactive-leaf-extractable.js";
import { providerPullsInTree } from "./provider-pulls-in-tree.js";
import { mixedModuleSplit } from "./mixed-module-split.js";
import { missingPoisonPill } from "./missing-poison-pill.js";
import { appBarrelReexport } from "./app-barrel-reexport.js";
import { nonSerializableProps } from "./non-serializable-props.js";
import { rscPayloadBloat } from "./rsc-payload-bloat.js";
import { metadataInClientFile } from "./metadata-in-client-file.js";

export const boundaryRules: Rule[] = [
  useClientUnnecessary,
  useClientTooHigh,
  useClientMixedComponents,
  interactiveLeafExtractable,
  providerPullsInTree,
  mixedModuleSplit,
  missingPoisonPill,
  appBarrelReexport,
  nonSerializableProps,
  rscPayloadBloat,
  metadataInClientFile,
];
