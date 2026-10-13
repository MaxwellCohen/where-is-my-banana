import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

/**
 * Run @e18e/cli analyze. Resolves the binary from the target app or wimb's
 * optional dependency before falling back to `npx`.
 */
export async function runE18eAnalysis(projectRoot: string): Promise<Finding[]> {
  try {
    const stdout = runE18eCli(projectRoot);
    const parsed = JSON.parse(stdout) as E18eJsonOutput;
    return (parsed.messages ?? []).map((msg, index) => toFinding(msg, index));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`wimb: e18e analysis skipped (${message})`);
    return [];
  }
}

function runE18eCli(projectRoot: string): string {
  const bin = resolveE18eBin(projectRoot);
  if (bin) {
    return execFileSync(bin, ["analyze", "--json"], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // Last resort: npx (may download)
  return execFileSync("npx", ["--yes", "@e18e/cli", "analyze", "--json"], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function resolveE18eBin(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, "node_modules", ".bin", "e18e"),
    join(projectRoot, "node_modules", "@e18e", "cli", "bin", "e18e.js"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  // Resolve from wimb's own node_modules (optionalDependency / peer)
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@e18e/cli/package.json");
    const dir = join(pkgJson, "..");
    for (const rel of ["bin/e18e.js", "dist/cli.js", "bin/cli.js"]) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    // package.json bin field
    const pkg = require("@e18e/cli/package.json") as { bin?: string | Record<string, string> };
    if (typeof pkg.bin === "string") {
      const candidate = join(dir, pkg.bin);
      if (existsSync(candidate)) return candidate;
    } else if (pkg.bin && typeof pkg.bin === "object") {
      for (const rel of Object.values(pkg.bin)) {
        const candidate = join(dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // not installed alongside wimb
  }

  return null;
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
