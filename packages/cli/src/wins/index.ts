import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseGraphV1Jsonl } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import { parseGraphV1File } from "@wimb/graph-v1/parse-file";
import { hasAnalyzeArtifacts, resolveAnalyzeDirs, projectSupportsAnalyzeExport, resolveDistDir } from "../build/analyze.js";
import { buildGraphFromBinary } from "./binary-graph.js";
import { attributeRoutes } from "./attribute.js";
import { classifyWins } from "./classify.js";
import type { WinsReport } from "./types.js";

export interface RunWinsOptions {
  projectRoot: string;
  analyzeExportPath?: string;
  distDir?: string;
  snapshot?: string;
  minBytes?: number;
}

const NO_DATA_MESSAGE =
  "No measured analyze data found. Run 'next analyze' (Next 16.4+) in the project first, or pass --analyze-export <file.jsonl[.gz]>.";

function exportJsonl(projectRoot: string, distDir: string, snapshot?: string): Promise<string> {
  const args = ["analyze", "export", "--dist-dir", distDir];
  if (snapshot) args.push("--snapshot", snapshot);
  const local = join(projectRoot, "node_modules", ".bin", "next");
  const [command, fullArgs] = existsSync(local) ? [local, args] : ["npx", ["next", ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TURBOPACK: "1" },
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => (out += c));
    child.stderr?.on("data", (c: Buffer | string) => (err = (err + String(c)).slice(-4_000)));
    child.on("error", (e) => reject(e));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`next analyze export failed (exit ${code})\n${err.trim()}`)),
    );
  });
}

export function runNextAnalyze(projectRoot: string, snapshot: string): Promise<void> {
  const args = ["analyze", "--output", "--snapshot", snapshot];
  const local = join(projectRoot, "node_modules", ".bin", "next");
  const [command, fullArgs] = existsSync(local) ? [local, args] : ["npx", ["next", ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`next analyze failed (exit ${code})`))));
  });
}

async function loadGraph(opts: RunWinsOptions): Promise<ParsedGraph> {
  if (opts.analyzeExportPath) {
    if (!existsSync(opts.analyzeExportPath)) {
      throw new Error(`analyze export not found at ${opts.analyzeExportPath}`);
    }
    return parseGraphV1File(opts.analyzeExportPath);
  }
  const distDir = resolveDistDir(opts.projectRoot, undefined, opts.distDir);
  if (!hasAnalyzeArtifacts(distDir) || !projectSupportsAnalyzeExport(opts.projectRoot)) {
    const dataDir = resolveAnalyzeDirs(distDir).dataDir;
    const bin = dataDir ? await buildGraphFromBinary(dataDir, opts.projectRoot) : null;
    if (bin) return bin.graph;
    throw new Error(NO_DATA_MESSAGE);
  }
  return parseGraphV1Jsonl(await exportJsonl(opts.projectRoot, distDir, opts.snapshot));
}

export async function runWins(opts: RunWinsOptions): Promise<WinsReport> {
  const graph = await loadGraph(opts);
  const attributions = attributeRoutes(graph, { minBytes: opts.minBytes });
  if (attributions.length === 0) throw new Error(NO_DATA_MESSAGE);
  const wins = await classifyWins(attributions, { projectRoot: opts.projectRoot, byteSource: "measured" });
  return {
    version: "2",
    timestamp: new Date().toISOString(),
    projectRoot: opts.projectRoot,
    byteSource: "measured",
    routes: attributions.map((a) => ({ route: a.route, firstLoadBytes: a.firstLoadBytes })),
    wins,
  };
}
