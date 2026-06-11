import type { Finding, RuleContext } from "./types.js";
import { buildGraph } from "./graph/builder.js";
import { loadPackageInfo } from "./graph/package-info.js";
import { loadDataTables } from "./data/index.js";
import { loadConfig, parseNextConfig } from "./config.js";
import { getAllRules } from "./rules/index.js";
import { runBuildAnalysis, resolveDistDir } from "./build/analyze.js";
import { resolveOutputDir } from "./paths.js";
import { buildReport, writeReports, exitCodeForReport } from "./report/index.js";
import { validateProject } from "./validate.js";
import { runE18eAnalysis } from "./external/e18e.js";

export interface ScanOptions {
  projectRoot: string;
  build?: boolean;
  distDir?: string;
  formats?: string[];
  exitThreshold?: "error" | "warning" | "info";
  e18e?: boolean;
  skipValidation?: boolean;
}

export async function scan(opts: ScanOptions): Promise<number> {
  const projectRoot = opts.projectRoot;

  if (!opts.skipValidation) {
    const validation = validateProject(projectRoot);
    if (!validation.ok) {
      for (const err of validation.errors) {
        console.error(`wimb: ${err}`);
      }
      return 2;
    }
  }

  const config = await loadConfig(projectRoot);
  const graph = await buildGraph(projectRoot);
  const pkg = loadPackageInfo(projectRoot);
  const data = loadDataTables();
  const nextConfig = await parseNextConfig(projectRoot);

  let byteAttribution = null;
  if (opts.build) {
    const resolved = opts.distDir ?? resolveDistDir(projectRoot, nextConfig?.distDir);
    byteAttribution = await runBuildAnalysis({
      projectRoot,
      distDir: resolved,
      skipBuild: !!opts.distDir,
    });
  }

  const findings: Finding[] = [];
  const shouldIgnore = (ruleId: string) =>
    config.ignores.rules.includes(ruleId) ||
    config.ignores.rules.some((r) => r.endsWith(":") && ruleId.startsWith(r));

  const ctx: RuleContext = {
    projectRoot,
    graph,
    config,
    pkg,
    data,
    nextConfig,
    byteAttribution,
    report: (f) => {
      if (shouldIgnore(f.ruleId)) return;
      findings.push(f);
    },
  };

  for (const rule of getAllRules()) {
    rule.run(ctx);
  }

  if (opts.e18e) {
    for (const finding of runE18eAnalysis(projectRoot)) {
      if (shouldIgnore(finding.ruleId)) continue;
      findings.push(finding);
    }
  }

  const mode = opts.build ? "build" : "source";
  const report = buildReport(projectRoot, mode, findings);
  const formats = new Set(opts.formats ?? ["json", "md"]);
  writeReports(projectRoot, report, formats);

  console.log(
    `wimb: ${report.summary.total} findings (${report.summary.bySeverity.error} errors, ${report.summary.bySeverity.warning} warnings) → ${resolveOutputDir(projectRoot)}`,
  );

  return exitCodeForReport(report, opts.exitThreshold ?? "error");
}
