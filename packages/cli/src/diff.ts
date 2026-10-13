import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding, ScanReport, WimbConfig } from "./types.js";
import { resolveOutputDir } from "./paths.js";

export interface DiffReport {
  version: string;
  timestamp: string;
  baselinePath: string;
  currentProjectRoot: string;
  byteDelta: number;
  baselineClientBytes: number;
  currentClientBytes: number;
  routeDeltas: { route: string; baseline: number; current: number; delta: number }[];
  newFindings: Finding[];
  resolvedFindings: Finding[];
  unchangedCount: number;
  budgetExceeded: boolean;
}

export function loadReport(path: string): ScanReport {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`baseline report not found: ${abs}`);
  }
  return JSON.parse(readFileSync(abs, "utf-8")) as ScanReport;
}

export function compareReports(
  baselinePathOrReport: string | ScanReport,
  current: ScanReport,
  config: WimbConfig,
): DiffReport {
  const baseline =
    typeof baselinePathOrReport === "string"
      ? loadReport(baselinePathOrReport)
      : baselinePathOrReport;
  const baselinePath =
    typeof baselinePathOrReport === "string" ? resolve(baselinePathOrReport) : "(in-memory)";

  const baselineBytes = baseline.summary.estimatedClientBytes ?? 0;
  const currentBytes = current.summary.estimatedClientBytes ?? 0;
  const byteDelta = currentBytes - baselineBytes;

  const baselineKeys = new Map(baseline.findings.map((f) => [findingKey(f), f]));
  const currentKeys = new Map(current.findings.map((f) => [findingKey(f), f]));

  const newFindings: Finding[] = [];
  const resolvedFindings: Finding[] = [];
  let unchangedCount = 0;

  for (const [key, finding] of currentKeys) {
    if (baselineKeys.has(key)) unchangedCount++;
    else newFindings.push(finding);
  }
  for (const [key, finding] of baselineKeys) {
    if (!currentKeys.has(key)) resolvedFindings.push(finding);
  }

  const routeDeltas = computeRouteDeltas(baseline, current);
  const budgetBytes = config.thresholds.diffBudgetBytes ?? 0;
  const budgetExceeded = budgetBytes > 0 && byteDelta > budgetBytes;

  return {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    baselinePath,
    currentProjectRoot: current.projectRoot,
    byteDelta,
    baselineClientBytes: baselineBytes,
    currentClientBytes: currentBytes,
    routeDeltas,
    newFindings,
    resolvedFindings,
    unchangedCount,
    budgetExceeded,
  };
}

function computeRouteDeltas(
  baseline: ScanReport,
  current: ScanReport,
): DiffReport["routeDeltas"] {
  const baseRoutes = extractRouteBytes(baseline);
  const curRoutes = extractRouteBytes(current);
  const routes = new Set([...baseRoutes.keys(), ...curRoutes.keys()]);
  const deltas: DiffReport["routeDeltas"] = [];
  for (const route of routes) {
    const b = baseRoutes.get(route) ?? 0;
    const c = curRoutes.get(route) ?? 0;
    if (b === c) continue;
    deltas.push({ route, baseline: b, current: c, delta: c - b });
  }
  return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function extractRouteBytes(report: ScanReport): Map<string, number> {
  const routes = new Map<string, number>();
  // Prefer explicit route evidence on route-over-budget findings
  for (const f of report.findings) {
    const route = f.evidence.route;
    if (typeof route === "string" && f.estimatedBytes != null) {
      routes.set(route, Math.max(routes.get(route) ?? 0, f.estimatedBytes));
    }
  }
  return routes;
}

function findingKey(f: Finding): string {
  return `${f.ruleId}|${f.file}|${typeof f.evidence.package === "string" ? f.evidence.package : ""}|${f.message}`;
}

export function writeDiffReport(projectRoot: string, diff: DiffReport): void {
  const dir = resolveOutputDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wimb-diff.json"), JSON.stringify(diff, null, 2));
  writeFileSync(join(dir, "wimb-diff.md"), toDiffMarkdown(diff));
}

export function exitCodeForDiff(diff: DiffReport, config: WimbConfig): number {
  if (diff.budgetExceeded) return 1;
  const failOnNew = config.thresholds.diffFailOnNewFindings !== false;
  if (failOnNew && diff.newFindings.some((f) => f.severity === "error")) return 1;
  return 0;
}

export function toDiffMarkdown(diff: DiffReport): string {
  const lines = [
    "# WIMB Diff Report",
    "",
    `**Baseline:** \`${diff.baselinePath}\``,
    `**Byte delta:** ${formatSignedBytes(diff.byteDelta)} (${formatBytes(diff.baselineClientBytes)} → ${formatBytes(diff.currentClientBytes)})`,
    `**Findings:** +${diff.newFindings.length} / -${diff.resolvedFindings.length} (unchanged ${diff.unchangedCount})`,
    diff.budgetExceeded ? "**Budget:** EXCEEDED" : "**Budget:** ok",
    "",
  ];

  if (diff.routeDeltas.length > 0) {
    lines.push("## Route deltas", "");
    for (const r of diff.routeDeltas) {
      lines.push(`- \`${r.route}\`: ${formatSignedBytes(r.delta)} (${formatBytes(r.baseline)} → ${formatBytes(r.current)})`);
    }
    lines.push("");
  }

  if (diff.newFindings.length > 0) {
    lines.push("## New findings", "");
    for (const f of diff.newFindings) {
      lines.push(`- **[${f.severity}] ${f.ruleId}** — ${f.file}: ${f.message}`);
    }
    lines.push("");
  }

  if (diff.resolvedFindings.length > 0) {
    lines.push("## Resolved findings", "");
    for (const f of diff.resolvedFindings) {
      lines.push(`- **[${f.severity}] ${f.ruleId}** — ${f.file}: ${f.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (Math.abs(n) >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatSignedBytes(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${formatBytes(n)}`;
}
