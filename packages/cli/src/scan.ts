import type { Finding, RuleContext } from "./types.js";
import { buildGraph } from "./graph/builder.js";
import { loadPackageInfo } from "./graph/package-info.js";
import { loadDataTables } from "./data/index.js";
import { loadConfig, parseNextConfig } from "./config.js";
import { getAllRules } from "./rules/index.js";
import { runBuildAnalysis, resolveDistDir } from "./build/analyze.js";
import { buildReport, writeReports, exitCodeForReport } from "./report/index.js";

export interface ScanOptions {
  projectRoot: string;
  build?: boolean;
  distDir?: string;
  formats?: string[];
  exitThreshold?: "error" | "warning" | "info";
  e18e?: boolean;
}

export async function scan(opts: ScanOptions): Promise<number> {
  const projectRoot = opts.projectRoot;
  const config = await loadConfig(projectRoot);
  const graph = await buildGraph(projectRoot);
  const pkg = loadPackageInfo(projectRoot);
  const data = loadDataTables();
  const nextConfig = parseNextConfig(projectRoot);

  let byteAttribution = null;
  if (opts.build) {
    const resolved = opts.distDir ?? resolveDistDir(projectRoot);
    byteAttribution = await runBuildAnalysis({
      projectRoot,
      distDir: resolved,
      skipBuild: !!opts.distDir,
    });
  }

  const findings: Finding[] = [];
  const ctx: RuleContext = {
    projectRoot,
    graph,
    config,
    pkg,
    data,
    nextConfig,
    byteAttribution,
    report: (f) => {
      if (config.ignores.rules.includes(f.ruleId)) return;
      findings.push(f);
    },
  };

  for (const rule of getAllRules()) {
    rule.run(ctx);
  }

  const mode = opts.build ? "build" : "source";
  const report = buildReport(projectRoot, mode, findings);
  const formats = new Set(opts.formats ?? ["json", "md"]);
  writeReports(projectRoot, report, formats);

  console.log(
    `wimb: ${report.summary.total} findings (${report.summary.bySeverity.error} errors, ${report.summary.bySeverity.warning} warnings)`,
  );

  return exitCodeForReport(report, opts.exitThreshold ?? "error");
}
