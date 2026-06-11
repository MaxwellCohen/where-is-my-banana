import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOutputDir } from "../paths.js";
import type { ScanReport, Finding, Severity } from "../types.js";
import { toMarkdown } from "./markdown.js";
import { toSarif } from "./sarif.js";

const SEVERITY_ORDER: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

export function buildReport(
  projectRoot: string,
  mode: "source" | "build",
  findings: Finding[],
): ScanReport {
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const byCategory: Record<string, number> = {};
  const byteKeys = new Map<string, number>();

  for (const f of findings) {
    bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    if (f.estimatedBytes == null) continue;
    const key = byteDedupeKey(f);
    const prev = byteKeys.get(key) ?? 0;
    byteKeys.set(key, Math.max(prev, f.estimatedBytes));
  }

  // Approximate upper bound — deduped by package/module per finding
  const estimatedClientBytes = [...byteKeys.values()].reduce((sum, n) => sum + n, 0);

  return {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    projectRoot,
    mode,
    findings: findings.sort(
      (a, b) =>
        (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0) ||
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity],
    ),
    summary: { total: findings.length, bySeverity, byCategory, estimatedClientBytes },
  };
}

export function writeReports(
  projectRoot: string,
  report: ScanReport,
  formats: Set<string>,
): void {
  const outputDir = resolveOutputDir(projectRoot);
  mkdirSync(outputDir, { recursive: true });

  if (formats.has("json") || formats.size === 0) {
    writeFileSync(join(outputDir, "wimb-report.json"), JSON.stringify(report, null, 2));
  }
  if (formats.has("md") || formats.size === 0) {
    writeFileSync(join(outputDir, "wimb-report.md"), toMarkdown(report));
  }
  if (formats.has("sarif")) {
    writeFileSync(join(outputDir, "wimb-report.sarif"), JSON.stringify(toSarif(report), null, 2));
  }
}

export function exitCodeForReport(report: ScanReport, threshold: Severity = "error"): number {
  const thresholdLevel = SEVERITY_ORDER[threshold];
  const hasAtOrAbove = report.findings.some((f) => SEVERITY_ORDER[f.severity] >= thresholdLevel);
  return hasAtOrAbove ? 1 : 0;
}

function byteDedupeKey(f: Finding): string {
  const { package: pkg, module: mod } = f.evidence;
  if (typeof pkg === "string" && pkg) return pkg;
  if (typeof mod === "string" && mod) return mod;
  return `${f.ruleId}:${f.file}`;
}
