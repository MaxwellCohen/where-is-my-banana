import type { Rule } from "../../types.js";
import { useClientUnnecessary } from "./use-client-unnecessary.js";
import { useClientTooHigh } from "./use-client-too-high.js";

export const boundaryRules: Rule[] = [useClientUnnecessary, useClientTooHigh];
