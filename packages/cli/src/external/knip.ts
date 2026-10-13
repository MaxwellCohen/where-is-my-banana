import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createOptions } from "knip/session";
import type { Issue, Issues } from "knip/session";
import type { Finding, ModuleGraph, WimbConfig } from "../types.js";

const DEPENDENCY_ISSUE_TYPES = ["dependencies", "devDependencies"] as const;
const KNIP_TIMEOUT_MS = 120_000;

/** Minimal knip config — avoid loading Storybook/Vite/etc. plugins. */
const KNIP_BASE_CONFIG = {
  storybook: false,
  eslint: false,
  vitest: false,
  playwright: false,
  cypress: false,
  jest: false,
  mocha: false,
  "github-actions": false,
};

async function runKnipMain(options: Awaited<ReturnType<typeof createOptions>>) {
  const { main } = (await import("knip")) as {
    main: (opts: Awaited<ReturnType<typeof createOptions>>) => Promise<{ issues: Issues }>;
  };
  return main(options);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createKnipConfigFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wimb-knip-"));
  const path = join(dir, "knip.json");
  writeFileSync(path, JSON.stringify(KNIP_BASE_CONFIG));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
    },
  };
}

/** @deprecated Prefer runKnipAnalysis */
export async function runKnipUnusedDependencyAnalysis(
  projectRoot: string,
  config: WimbConfig,
): Promise<Finding[]> {
  return runKnipAnalysis(projectRoot, config, null);
}

/**
 * Run knip and map unused dependencies + unused files/exports that are
 * client-reachable (dead code that can ship to the browser).
 */
export async function runKnipAnalysis(
  projectRoot: string,
  config: WimbConfig,
  graph: ModuleGraph | null,
): Promise<Finding[]> {
  const ignoreUnusedDeps = config.ignores.rules.includes("unused-dependency");
  const ignoreUnusedExports =
    config.ignores.rules.includes("unused-client-export") ||
    config.ignores.rules.includes("unused-client-file");

  const includedIssueTypes: string[] = [];
  if (!ignoreUnusedDeps) includedIssueTypes.push("dependencies");
  if (!ignoreUnusedExports) includedIssueTypes.push("files", "exports", "types");

  if (includedIssueTypes.length === 0) return [];

  const { path: knipConfigPath, cleanup } = createKnipConfigFile();
  try {
    const options = await createOptions({
      cwd: projectRoot,
      includedIssueTypes,
      isShowProgress: false,
      args: { config: knipConfigPath },
    });
    const { issues } = await withTimeout(
      runKnipMain(options),
      KNIP_TIMEOUT_MS,
      "knip analysis",
    );

    const findings: Finding[] = [];
    if (!ignoreUnusedDeps) {
      findings.push(...collectDependencyFindings(issues, config));
    }
    if (!ignoreUnusedExports && graph) {
      findings.push(...collectClientDeadCodeFindings(issues, config, projectRoot, graph));
    }
    return findings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`wimb: knip analysis skipped (${message})`);
    return [];
  } finally {
    cleanup();
  }
}

function collectDependencyFindings(issues: Issues, config: WimbConfig): Finding[] {
  const findings: Finding[] = [];

  for (const issueType of DEPENDENCY_ISSUE_TYPES) {
    for (const issue of flattenIssues(issues[issueType])) {
      if (isPackageIgnored(config, issue.symbol)) continue;
      findings.push(toDependencyFinding(issue, issueType, config));
    }
  }

  return findings;
}

function collectClientDeadCodeFindings(
  issues: Issues,
  config: WimbConfig,
  projectRoot: string,
  graph: ModuleGraph,
): Finding[] {
  const findings: Finding[] = [];
  const clientAbs = new Set(
    [...graph.clientModules].map((p) => resolve(p)),
  );
  const clientRel = new Set(
    [...graph.clientModules].map((p) => relative(projectRoot, p).replace(/\\/g, "/")),
  );

  const isClientPath = (filePath: string): boolean => {
    const abs = resolve(projectRoot, filePath);
    const rel = relative(projectRoot, abs).replace(/\\/g, "/");
    return clientAbs.has(abs) || clientRel.has(rel) || clientRel.has(filePath.replace(/\\/g, "/"));
  };

  // Unused files that are client-reachable
  for (const issue of flattenIssues(issues.files ?? {})) {
    if (!isClientPath(issue.filePath)) continue;
    const severity = config.severityOverrides["unused-client-file"] ?? "warning";
    findings.push({
      id: `file:${issue.filePath}:unused-client-file`,
      ruleId: "unused-client-file",
      category: "dependency",
      severity,
      confidence: "medium",
      file: issue.filePath,
      loc: issue.line ? { line: issue.line, column: issue.col ?? 1 } : undefined,
      message: `Unused client-reachable file '${issue.filePath}' — dead code that may ship to the browser`,
      evidence: { knip: issue, kind: "files" },
      fixStrategy: {
        name: "remove-dead-file",
        steps: [`Delete unused file '${issue.filePath}' or wire it into a used import`],
      },
      source: "knip",
    });
  }

  // Unused exports / types in client modules
  for (const issueType of ["exports", "types"] as const) {
    for (const issue of flattenIssues(issues[issueType] ?? {})) {
      if (!isClientPath(issue.filePath)) continue;
      const severity = config.severityOverrides["unused-client-export"] ?? "info";
      findings.push({
        id: `export:${issue.filePath}:${issue.symbol}:unused-client-export`,
        ruleId: "unused-client-export",
        category: "dependency",
        severity,
        confidence: "medium",
        file: issue.filePath,
        loc: issue.line ? { line: issue.line, column: issue.col ?? 1 } : undefined,
        message: `Unused ${issueType === "types" ? "type" : "export"} '${issue.symbol}' in client module`,
        evidence: { knip: issue, kind: issueType, export: issue.symbol },
        fixStrategy: {
          name: "remove-dead-export",
          steps: [`Remove unused export '${issue.symbol}' from '${issue.filePath}'`],
        },
        source: "knip",
      });
    }
  }

  return findings;
}

function flattenIssues(records: Record<string, Record<string, Issue>> | Issue[] | undefined): Issue[] {
  if (!records) return [];
  if (Array.isArray(records)) return records;
  const result: Issue[] = [];
  for (const workspaceIssues of Object.values(records)) {
    if (!workspaceIssues || typeof workspaceIssues !== "object") continue;
    // files may be Record<string, Issue> or nested
    for (const value of Object.values(workspaceIssues)) {
      if (value && typeof value === "object" && "filePath" in value) {
        result.push(value as Issue);
      } else if (value && typeof value === "object") {
        for (const issue of Object.values(value as Record<string, Issue>)) {
          if (issue && typeof issue === "object" && "filePath" in issue) {
            result.push(issue);
          }
        }
      }
    }
  }
  return result;
}

function isPackageIgnored(config: WimbConfig, packageName: string): boolean {
  return config.ignores.files.some((pattern) => packageName.includes(pattern));
}

function toDependencyFinding(
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
