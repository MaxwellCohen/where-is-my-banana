import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "../src/types.js";
import { buildGraph } from "../src/graph/builder.js";
import { loadPackageInfo } from "../src/graph/package-info.js";
import { loadDataTables } from "../src/data/index.js";
import { DEFAULT_CONFIG, parseNextConfig } from "../src/config.js";
import { getAllRules } from "../src/rules/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return join(__dirname, "fixtures", name);
}

export async function runScanOnFixture(name: string): Promise<Finding[]> {
  const projectRoot = fixturePath(name);
  const findings: Finding[] = [];
  const graph = await buildGraph(projectRoot);
  const ctx = {
    projectRoot,
    graph,
    config: DEFAULT_CONFIG,
    pkg: loadPackageInfo(projectRoot),
    data: loadDataTables(),
    nextConfig: parseNextConfig(projectRoot),
    byteAttribution: null,
    report: (f: Finding) => findings.push(f),
  };
  for (const rule of getAllRules()) {
    rule.run(ctx);
  }
  return findings;
}
