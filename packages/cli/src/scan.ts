import type { ByteAttribution, Finding, RuleContext } from "./types.js";
import { buildGraph } from "./graph/builder.js";
import { loadPackageInfo } from "./graph/package-info.js";
import { loadDataTables } from "./data/index.js";
import { loadConfig, parseNextConfig } from "./config.js";
import { getAllRules } from "./rules/index.js";
import { hasAnalyzeArtifacts, runBuildAnalysis, resolveDistDir } from "./build/analyze.js";
import { resolveOutputDir } from "./paths.js";
import { buildReport, writeReports, exitCodeForReport } from "./report/index.js";
import { printFindingsToTerminal } from "./report/terminal.js";
import { writeForestReport } from "./forest/builder.js";
import { validateProject } from "./validate.js";
import { runKnipAnalysis } from "./external/knip.js";
import { measureClientPackageSizes } from "./analysis/package-size.js";

export interface ScanOptions {
  projectRoot: string;
  build?: boolean;
  distDir?: string;
  formats?: string[];
  exitThreshold?: "error" | "warning" | "info";
  skipValidation?: boolean;
  forestCompact?: boolean;
  /** Named `next analyze` snapshot (Next 16.4+). */
  snapshot?: string;
  /** Path to `next analyze export` JSONL (`.jsonl` or `.jsonl.gz`). */
  analyzeExportPath?: string;
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

  const resolvedDist = opts.distDir ?? resolveDistDir(projectRoot, nextConfig?.distDir);
  const existingAnalyze = hasAnalyzeArtifacts(resolvedDist);

  let byteAttribution = null;
  if (opts.build || opts.distDir || existingAnalyze || opts.analyzeExportPath) {
    byteAttribution = await runBuildAnalysis({
      projectRoot,
      distDir: resolvedDist,
      skipBuild: !!opts.analyzeExportPath || !!opts.distDir || (!opts.build && existingAnalyze),
      snapshot: opts.snapshot,
      analyzeExportPath: opts.analyzeExportPath,
    });
  }

  // Enrich install sizes with measured package costs for client-reachable packages
  await measureClientPackageSizes(projectRoot, graph, pkg, byteAttribution);

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
      findings.push(labelByteSource(f, byteAttribution));
    },
  };

  for (const rule of getAllRules()) {
    rule.run(ctx);
  }

  if (!shouldIgnore("unused-dependency") || !shouldIgnore("unused-client-export")) {
    console.log("wimb: checking unused code with knip...");
    for (const finding of await runKnipAnalysis(projectRoot, config, graph)) {
      if (shouldIgnore(finding.ruleId)) continue;
      findings.push(finding);
    }
  }

  const mode = opts.build || byteAttribution?.measured ? "build" : "source";
  const report = buildReport(projectRoot, mode, findings, {
    byteSource: byteAttribution?.measured ? "measured" : "estimated",
  });
  const formats = new Set(opts.formats ?? ["json", "md"]);
  writeReports(projectRoot, report, formats);

  console.log("wimb: writing forest.json...");
  const forest = writeForestReport(projectRoot, graph, byteAttribution, {
    compact: opts.forestCompact,
    heavySubtreeThreshold: config.thresholds.dynamicImportMinSubtree,
    verbose: true,
  });

  printFindingsToTerminal(report);

  console.log(
    `wimb: ${report.summary.total} findings (${report.summary.bySeverity.error} errors, ${report.summary.bySeverity.warning} warnings), ${forest.pages.length} pages → ${resolveOutputDir(projectRoot)}`,
  );

  if (byteAttribution?.measured) {
    console.log("wimb: measured graph available — run `wimb wins` for ranked, agent-ready fixes");
  }

  return exitCodeForReport(report, opts.exitThreshold ?? "error");
}

function labelByteSource(finding: Finding, byteAttribution: ByteAttribution | null): Finding {
  if (finding.estimatedBytes == null) return finding;
  if (finding.byteSource) return finding;
  return {
    ...finding,
    byteSource: byteAttribution?.measured ? "measured" : "estimated",
  };
}
