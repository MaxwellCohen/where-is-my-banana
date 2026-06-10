import { execSync } from "node:child_process";
import type { Finding, Severity } from "../types.js";

interface E18eMessage {
  ruleId?: string;
  message?: string;
  severity?: string;
  filePath?: string;
  line?: number;
  column?: number;
  category?: string;
  fixable?: boolean;
}

interface E18eJsonOutput {
  messages?: E18eMessage[];
}

const SEVERITY_MAP: Record<string, Severity> = {
  error: "error",
  warn: "warning",
  warning: "warning",
  info: "info",
};

export function runE18eAnalysis(projectRoot: string): Finding[] {
  try {
    const stdout = execSync("npx @e18e/cli analyze --json", {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const parsed = JSON.parse(stdout) as E18eJsonOutput;
    return (parsed.messages ?? []).map((msg, index) => toFinding(msg, index));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`wimb: e18e analysis skipped (${message})`);
    return [];
  }
}

function toFinding(msg: E18eMessage, index: number): Finding {
  const category = msg.category ?? "dependency";
  const ruleId = msg.ruleId ? `e18e:${msg.ruleId}` : `e18e:${category}`;
  const severity = SEVERITY_MAP[msg.severity ?? "info"] ?? "info";

  return {
    id: `e18e:${index}:${ruleId}`,
    ruleId,
    category,
    severity,
    confidence: "high",
    file: msg.filePath ?? "package.json",
    loc: msg.line
      ? { line: msg.line, column: msg.column ?? 1 }
      : undefined,
    message: msg.message ?? "e18e diagnostic",
    evidence: { e18e: msg },
    fixStrategy: {
      name: msg.fixable ? "e18e-fixable" : "e18e-review",
      steps: msg.fixable
        ? ["Run npx @e18e/cli migrate for automated fixes where available"]
        : ["Review e18e diagnostic and apply suggested remediation"],
    },
    source: "e18e",
  };
}
