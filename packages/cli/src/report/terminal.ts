import type { ScanReport } from "../types.js";

const SEVERITY_WIDTH = 7;

export function formatFindingsForTerminal(report: ScanReport): string {
  const lines: string[] = [];

  for (const f of report.findings) {
    const loc = f.loc ? `:${f.loc.line}` : "";
    const bytes =
      f.estimatedBytes != null && f.estimatedBytes > 0
        ? ` (${formatBytes(f.estimatedBytes)})`
        : "";

    lines.push(
      `${f.severity.padEnd(SEVERITY_WIDTH)} ${f.ruleId}  ${f.file}${loc}${bytes}`,
    );
    lines.push(`       ${f.message}`);
    if (f.fixStrategy.steps.length > 0) {
      lines.push(`       → ${f.fixStrategy.steps[0]}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n$/, "");
}

export function printFindingsToTerminal(report: ScanReport): void {
  if (report.findings.length === 0) return;
  console.log(formatFindingsForTerminal(report));
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
