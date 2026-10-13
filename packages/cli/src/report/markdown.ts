import type { Finding, ScanReport, Severity } from "../types.js";

const SEVERITY_SECTIONS: Severity[] = ["error", "warning", "info"];

export function toMarkdown(report: ScanReport): string {
  const lines: string[] = [
    "# WIMB Report — Where Is My Banana",
    "",
    `**Mode:** ${report.mode} | **Findings:** ${report.summary.total} | **${report.summary.byteSource === "measured" ? "Measured" : "Est."} client bytes:** ${formatBytes(report.summary.estimatedClientBytes)}`,
    "",
    "## Summary",
    "",
    `| Severity | Count |`,
    `|----------|-------|`,
    `| Error | ${report.summary.bySeverity.error} |`,
    `| Warning | ${report.summary.bySeverity.warning} |`,
    `| Info | ${report.summary.bySeverity.info} |`,
    "",
  ];

  for (const severity of SEVERITY_SECTIONS) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;

    lines.push(`## ${severityLabel(severity)} (${group.length})`);
    lines.push("");

    for (const f of group) {
      appendFinding(lines, f);
    }
  }

  return lines.join("\n");
}

function appendFinding(lines: string[], f: Finding): void {
  lines.push(`### [${f.severity}] ${f.ruleId}`);
  lines.push("");
  lines.push(`**File:** \`${f.file}\`${f.loc ? ` (line ${f.loc.line})` : ""}`);
  lines.push(`**Confidence:** ${f.confidence}`);
  if (f.estimatedBytes) {
    const label = f.byteSource === "measured" ? "Measured bytes" : "Est. bytes";
    lines.push(`**${label}:** ${formatBytes(f.estimatedBytes)}`);
  }
  lines.push("");
  lines.push(f.message);
  lines.push("");
  lines.push("**Fix:**");
  for (const step of f.fixStrategy.steps) {
    lines.push(`- ${step}`);
  }
  lines.push("");
}

function severityLabel(severity: Severity): string {
  if (severity === "error") return "Errors";
  if (severity === "warning") return "Warnings";
  return "Info";
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
