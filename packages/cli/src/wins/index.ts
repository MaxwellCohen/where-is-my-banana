import { existsSync } from "node:fs";
import { parseGraphV1Jsonl } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import { parseGraphV1File } from "@wimb/graph-v1/parse-file";
import { parseNextConfig } from "../config.js";
import { hasAnalyzeArtifacts, resolveAnalyzeDirs, projectSupportsAnalyzeExport, resolveDistDir } from "../build/analyze.js";
import { buildGraphFromBinary } from "./binary-graph.js";
import { buildGraphFromVite, isViteProject } from "../sources/vite.js";
import { nextHasAnalyze, runNext } from "./next-cli.js";
import { attributeRoutes } from "./attribute.js";
import { classifyWins, detectFramework } from "./classify.js";
import type { WinsReport } from "./types.js";

export interface RunWinsOptions {
  projectRoot: string;
  analyzeExportPath?: string;
  distDir?: string;
  snapshot?: string;
  minBytes?: number;
  /** Force the Vite path (auto-detected when vite is a dependency and next is not). */
  vite?: boolean;
  /** False when the caller skipped `next analyze` (--no-analyze); only used to explain missing data. */
  analyzed?: boolean;
  /** Receives the parsed graph when one is built (not for the legacy binary path). */
  onGraph?: (graph: ParsedGraph) => void;
}

const NO_DATA_HINT = "Run 'next analyze' (Next 16.4+) in the project first, or pass --analyze-export <file.jsonl[.gz]>.";
const NO_ATTRIBUTION_MESSAGE = `No client bytes could be attributed to any route. ${NO_DATA_HINT}`;

function exportJsonl(projectRoot: string, distDir: string, snapshot?: string): Promise<string> {
  const args = ["analyze", "export", "--dist-dir", distDir];
  if (snapshot) args.push("--snapshot", snapshot);
  return runNext(projectRoot, args, { capture: true, env: { TURBOPACK: "1" } });
}

export async function runNextAnalyze(projectRoot: string, snapshot: string): Promise<void> {
  const args = nextHasAnalyze(projectRoot)
    ? ["analyze", "--output", "--snapshot", snapshot]
    : ["experimental-analyze", "--output"];
  await runNext(projectRoot, args);
}

async function loadGraph(opts: RunWinsOptions): Promise<ParsedGraph> {
  if (opts.analyzeExportPath) {
    if (!existsSync(opts.analyzeExportPath)) {
      throw new Error(`analyze export not found at ${opts.analyzeExportPath}`);
    }
    return parseGraphV1File(opts.analyzeExportPath);
  }
  if (opts.vite ?? isViteProject(opts.projectRoot)) return buildGraphFromVite(opts.projectRoot);
  const distDir = resolveDistDir(opts.projectRoot, (await parseNextConfig(opts.projectRoot))?.distDir, opts.distDir);
  if (!hasAnalyzeArtifacts(distDir) || !projectSupportsAnalyzeExport(opts.projectRoot)) {
    const dataDir = resolveAnalyzeDirs(distDir).dataDir;
    const bin = dataDir ? await buildGraphFromBinary(dataDir, opts.projectRoot) : null;
    if (bin) return bin.graph;
    const reasons: string[] = [];
    if (!hasAnalyzeArtifacts(distDir)) {
      reasons.push(
        opts.analyzed === false
          ? `no analyze artifacts in ${distDir} and --no-analyze was set (drop it to run 'next analyze')`
          : `no analyze artifacts in ${distDir}`,
      );
    }
    if (!projectSupportsAnalyzeExport(opts.projectRoot)) {
      reasons.push("installed Next version does not support 'next analyze export' (needs 16.4+)");
    }
    throw new Error(`No measured analyze data found: ${reasons.join("; ")}. ${NO_DATA_HINT}`);
  }
  return parseGraphV1Jsonl(await exportJsonl(opts.projectRoot, distDir, opts.snapshot));
}

export async function runWins(opts: RunWinsOptions): Promise<WinsReport> {
  const graph = await loadGraph(opts);
  opts.onGraph?.(graph);
  const attributions = attributeRoutes(graph, { minBytes: opts.minBytes });
  if (attributions.length === 0) throw new Error(NO_ATTRIBUTION_MESSAGE);
  const wins = await classifyWins(attributions, { projectRoot: opts.projectRoot, byteSource: "measured", framework: detectFramework(opts.projectRoot) });
  return {
    version: "2",
    timestamp: new Date().toISOString(),
    projectRoot: opts.projectRoot,
    byteSource: "measured",
    routes: attributions.map((a) => ({ route: a.route, firstLoadBytes: a.firstLoadBytes })),
    wins,
  };
}
