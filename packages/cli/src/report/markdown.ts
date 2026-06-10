import type { ScanReport } from "../types.js";

export function toMarkdown(report: ScanReport): string {
  const lines: string[] = [
    "# WIMB Report — Where Is My Banana",
    "",
    `**Mode:** ${report.mode} | **Findings:** ${report.summary.total} | **Est. client bytes:** ${formatBytes(report.summary.estimatedClientBytes)}`,
    "",
    "## Summary",
    "",
    `| Severity | Count |`,
    `|----------|-------|`,
    `| Error | ${report.summary.bySeverity.error} |`,
    `| Warning | ${report.summary.bySeverity.warning} |`,
    `| Info | ${report.summary.bySeverity.info} |`,
    "",
    "## Top Findings",
    "",
  ];

  const top = report.findings.slice(0, 20);
  for (const f of top) {
    lines.push(`### [${f.severity}] ${f.ruleId}`);
    lines.push("");
    lines.push(`**File:** \`${f.file}\`${f.loc ? ` (line ${f.loc.line})` : ""}`);
    lines.push(`**Confidence:** ${f.confidence}`);
    if (f.estimatedBytes) lines.push(`**Est. bytes:** ${formatBytes(f.estimatedBytes)}`);
    lines.push("");
    lines.push(f.message);
    lines.push("");
    lines.push("**Fix:**");
    for (const step of f.fixStrategy.steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
