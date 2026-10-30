import heavyPackages from "./heavy-packages.json" with { type: "json" };
import frameworkPackages from "./framework-packages.json" with { type: "json" };
import categoryMap from "./category-map.json" with { type: "json" };
import onDemandLibs from "./on-demand-libs.json" with { type: "json" };
import heavyComponents from "./heavy-components.json" with { type: "json" };
import barrelPackages from "./barrel-packages.json" with { type: "json" };
import type { DataTables } from "../types.js";

export function loadDataTables(): DataTables {
  return {
    heavyPackages: new Set(heavyPackages),
    frameworkPackages: new Set(frameworkPackages),
    categoryMap: categoryMap as Record<string, string[]>,
    onDemandLibs: new Set(onDemandLibs),
    heavyComponents: new Set(heavyComponents),
    barrelPackages: new Set(barrelPackages),
  };
}
