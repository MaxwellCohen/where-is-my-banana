import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildDualRouteForest,
  type BuildForestOptions,
  type VizGraph,
} from "@wimb/graph-v1";
import { parseGraphV1File } from "@wimb/graph-v1/parse-file";
import { resolveAnalyzeDirs, resolveDistDir } from "./build/analyze.js";
import { buildRouteForestFromBinary } from "./viz/binary-forest.js";

export interface VizBuildOptions {
  /** Pre-exported `next analyze export` JSONL (.jsonl / .jsonl.gz). */
  analyzeExportPath?: string;
  /** Project root — used with distDir to find binary analyze artifacts. */
  projectRoot?: string;
  /** Override distDir (defaults to `.next`). */
  distDir?: string;
  outputPath: string;
  includeAsync?: boolean;
  includeTraced?: boolean;
}

export function buildVizGraph(opts: VizBuildOptions): VizGraph {
  if (opts.analyzeExportPath) {
    const graph = parseGraphV1File(opts.analyzeExportPath);
    const forestOpts: BuildForestOptions = {
      includeAsync: opts.includeAsync,
      includeTraced: opts.includeTraced,
    };
    return buildDualRouteForest(graph, forestOpts);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const distDir = resolveDistDir(projectRoot, undefined, opts.distDir);
  const { dataDir } = resolveAnalyzeDirs(distDir);
  if (!dataDir || !existsSync(dataDir)) {
    throw new Error(
      `No analyze artifacts at ${join(distDir, "diagnostics", "analyze")}. ` +
        `Run 'next experimental-analyze --output' (or Next 16.4+ 'next analyze --output'), ` +
        `or pass --analyze-export <file.jsonl.gz>.`,
    );
  }

  return buildRouteForestFromBinary(dataDir);
}

export function writeVizGraph(opts: VizBuildOptions): VizGraph {
  const viz = buildVizGraph(opts);
  const out = resolve(opts.outputPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(viz, null, 2)}\n`, "utf-8");
  return viz;
}
