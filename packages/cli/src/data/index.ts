import heavyPackages from "./heavy-packages.json" with { type: "json" };
import categoryMap from "./category-map.json" with { type: "json" };
import serverPackages from "./server-packages.json" with { type: "json" };
import authCryptoPackages from "./auth-crypto-packages.json" with { type: "json" };
import devPackages from "./dev-packages.json" with { type: "json" };
import thirdPartyScripts from "./third-party-scripts.json" with { type: "json" };
import onDemandLibs from "./on-demand-libs.json" with { type: "json" };
import heavyComponents from "./heavy-components.json" with { type: "json" };
import barrelPackages from "./barrel-packages.json" with { type: "json" };
import type { DataTables } from "../types.js";

const STATIC_RENDERERS = [
  "react-markdown",
  "marked",
  "remark",
  "highlight.js",
  "prismjs",
  "shiki",
  "katex",
];

const WASM_PACKAGES = [
  "@ffmpeg/ffmpeg",
  "sql.js",
  "tesseract.js",
  "@sqlite.org/sqlite-wasm",
];

const LOCALE_PATTERNS = [
  /moment\/locale$/,
  /moment-timezone$/,
  /date-fns\/locale$/,
  /cldr-data/,
  /intl-pluralrules/,
];

export function loadDataTables(): DataTables {
  return {
    heavyPackages: new Set(heavyPackages),
    categoryMap: categoryMap as Record<string, string[]>,
    serverPackages: new Set(serverPackages),
    authCryptoPackages: new Set(authCryptoPackages),
    devPackages: new Set(devPackages),
    thirdPartyScripts: new Set(thirdPartyScripts),
    onDemandLibs: new Set(onDemandLibs),
    heavyComponents: new Set(heavyComponents),
    barrelPackages: new Set(barrelPackages),
    staticRenderers: new Set(STATIC_RENDERERS),
    wasmPackages: new Set(WASM_PACKAGES),
    localePatterns: LOCALE_PATTERNS.map((p) => new RegExp(p)),
  };
}
