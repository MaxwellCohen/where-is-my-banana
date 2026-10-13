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
import { runE18eAnalysis } from "./external/e18e.js";
import { runKnipAnalysis } from "./external/knip.js";
import { runRscXrayAnalysis } from "./external/rsc-xray.js";
import { measureClientPackageSizes } from "./analysis/package-size.js";

export interface ScanOptions {
  projectRoot: string;
  build?: boolean;
  distDir?: string;
  formats?: string[];
  exitThreshold?: "error" | "warning" | "info";
  e18e?: boolean;
  rscXray?: boolean;
  baseline?: string;
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

  if (opts.e18e) {
    for (const finding of await runE18eAnalysis(projectRoot)) {
      if (shouldIgnore(finding.ruleId)) continue;
      findings.push(finding);
    }
  }

  if (opts.rscXray) {
    for (const finding of await runRscXrayAnalysis(projectRoot, config)) {
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

  if (opts.baseline) {
    const { compareReports, writeDiffReport, exitCodeForDiff } = await import("./diff.js");
    const diff = compareReports(opts.baseline, report, config);
    writeDiffReport(projectRoot, diff);
    console.log(
      `wimb: diff vs baseline — Δbytes ${diff.byteDelta}, +${diff.newFindings.length}/-${diff.resolvedFindings.length} findings`,
    );
    if (exitCodeForDiff(diff, config) !== 0) {
      // Still print findings; exit code applied at the end
      printFindingsToTerminal(report);
      console.log(
        `wimb: ${report.summary.total} findings, budget exceeded → ${resolveOutputDir(projectRoot)}`,
      );
      return 1;
    }
  }

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
