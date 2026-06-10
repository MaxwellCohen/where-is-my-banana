import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WimbConfig, ParsedNextConfig } from "./types.js";

export const DEFAULT_CONFIG: WimbConfig = {
  thresholds: {
    subtreeBytesHigh: 50_000,
    largeLiteralBytes: 10_240,
    largeJsonBytes: 20_480,
    heavyPackageBytes: 512_000,
    middlewareSourceBytes: 204_800,
    middlewarePackageBytes: 102_400,
    routeBudgetBytes: 500_000,
    interactiveLeafRatio: 0.25,
    barrelReexportRatio: 0.8,
    barrelMinReexports: 5,
    iconMapMinEntries: 10,
    inlineSvgMinCount: 10,
    inlineSvgMinBytes: 30_720,
    dynamicImportMinSubtree: 20_480,
    dynamicMisuseMaxSubtree: 5_120,
    clientSignalRatio: 0.3,
    providerMinImports: 2,
    providerMaxInstallSize: 102_400,
    searchIndexMinBytes: 20_480,
    base64MinBytes: 5_120,
    rscPayloadMaxFields: 3,
  },
  ignores: { files: [], rules: [] },
  severityOverrides: {},
};

export async function loadConfig(projectRoot: string): Promise<WimbConfig> {
  const configPath = join(projectRoot, "wimb.config.ts");
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const mod = await import(configPath);
    return { ...DEFAULT_CONFIG, ...mod.default };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const NEXT_BUILTIN_OPTIMIZE = [
  "lucide-react",
  "date-fns",
  "lodash-es",
  "@mui/material",
  "@mui/icons-material",
  "react-icons",
  "antd",
  "ramda",
];

export function parseNextConfig(projectRoot: string): ParsedNextConfig | null {
  const candidates = ["next.config.ts", "next.config.mjs", "next.config.js"];
  for (const name of candidates) {
    const path = join(projectRoot, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    const distDir = extractStringProp(content, "distDir") ?? ".next";
    const optimize = extractArrayProp(content, "optimizePackageImports") ?? [];
    const fallbacks = extractWebpackFallbacks(content);
    const aliases = extractResolveAliases(content);
    return {
      distDir,
      optimizePackageImports: optimize,
      webpackFallbacks: fallbacks,
      resolveAliases: aliases,
    };
  }
  return null;
}

function extractStringProp(content: string, prop: string): string | null {
  const re = new RegExp(`${prop}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = content.match(re);
  return m?.[1] ?? null;
}

function extractArrayProp(content: string, prop: string): string[] | null {
  const re = new RegExp(`${prop}\\s*:\\s*\\[([^\\]]+)\\]`);
  const m = content.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
}

function extractWebpackFallbacks(content: string): string[] {
  const fallbacks: string[] = [];
  const re = /fallback\s*:\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    for (const key of m[1].matchAll(/['"`]?(\w+)['"`]?\s*:/g)) {
      fallbacks.push(key[1]);
    }
  }
  return fallbacks;
}

function extractResolveAliases(content: string): string[] {
  const aliases: string[] = [];
  const re = /alias\s*:\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    for (const key of m[1].matchAll(/['"`]([^'"`]+)['"`]\s*:/g)) {
      aliases.push(key[1]);
    }
  }
  return aliases;
}

export { NEXT_BUILTIN_OPTIMIZE };
