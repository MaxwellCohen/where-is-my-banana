import { createOptions } from "knip/session";
import type { Issue, Issues } from "knip/session";
import type { Finding, WimbConfig } from "../types.js";

const DEPENDENCY_ISSUE_TYPES = ["dependencies", "devDependencies"] as const;

async function runKnipMain(options: Awaited<ReturnType<typeof createOptions>>) {
  const { main } = (await import("knip")) as {
    main: (opts: Awaited<ReturnType<typeof createOptions>>) => Promise<{ issues: Issues }>;
  };
  return main(options);
}

export async function runKnipUnusedDependencyAnalysis(
  projectRoot: string,
  config: WimbConfig,
): Promise<Finding[]> {
  try {
    const options = await createOptions({
      cwd: projectRoot,
      includedIssueTypes: ["dependencies"],
      isShowProgress: false,
    });
    const { issues } = await runKnipMain(options);
    return collectDependencyFindings(issues, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`wimb: knip unused-dependency analysis skipped (${message})`);
    return [];
  }
}

function collectDependencyFindings(issues: Issues, config: WimbConfig): Finding[] {
  const findings: Finding[] = [];

  for (const issueType of DEPENDENCY_ISSUE_TYPES) {
    for (const issue of flattenIssues(issues[issueType])) {
      if (isPackageIgnored(config, issue.symbol)) continue;
      findings.push(toFinding(issue, issueType, config));
    }
  }

  return findings;
}

function flattenIssues(records: Record<string, Record<string, Issue>>): Issue[] {
  const result: Issue[] = [];
  for (const workspaceIssues of Object.values(records)) {
    for (const issue of Object.values(workspaceIssues)) {
      result.push(issue);
    }
  }
  return result;
}

function isPackageIgnored(config: WimbConfig, packageName: string): boolean {
  return config.ignores.files.some((pattern) => packageName.includes(pattern));
}

function toFinding(
  issue: Issue,
  issueType: (typeof DEPENDENCY_ISSUE_TYPES)[number],
  config: WimbConfig,
): Finding {
  const field = issueType === "devDependencies" ? "devDependencies" : "dependencies";
  const severity = config.severityOverrides["unused-dependency"] ?? "info";

  return {
    id: `pkg:${issue.workspace}:${issue.symbol}:unused-dependency`,
    ruleId: "unused-dependency",
    category: "dependency",
    severity,
    confidence: "high",
    file: issue.filePath,
    loc: issue.line ? { line: issue.line, column: issue.col ?? 1 } : undefined,
    message: `Unused ${field === "devDependencies" ? "devDependency" : "dependency"} '${issue.symbol}'`,
    evidence: { package: issue.symbol, field, workspace: issue.workspace, knip: issue },
    fixStrategy: {
      name: "remove-dep",
      steps: [`Remove '${issue.symbol}' from package.json ${field}`],
    },
    source: "knip",
  };
}
