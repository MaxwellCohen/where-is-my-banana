export type Severity = "high" | "medium" | "low";

export const CHECKS = [
  "third-party-script",
  "raw-img",
  "lcp-priority",
  "image-config",
  "cms-image-params",
  "fonts",
  "force-dynamic",
  "missing-static-params",
  "sequential-await",
  "full-cms-payload-to-client",
  "heavy-deps",
  "old-browserslist",
  "maps-widgets",
  "middleware-scope",
  "preview-code-in-prod",
  "css-weight",
  "use-client-inventory",
  "ssr-false-misuse",
] as const;
export type CheckName = (typeof CHECKS)[number];

export interface Finding {
  /** Stable rule id, `check` or `check/sub-rule`. */
  id: string;
  check: CheckName;
  severity: Severity;
  file: string;
  line: number;
  message: string;
  fix: string;
  /** Workspace package name (monorepo mode only). */
  package?: string;
  /** 0-100 estimate of user-visible impact (see README "Scoring"). */
  impactScore?: number;
  /** Rough work to fix: S (minutes), M (an hour), L (a day+). */
  effort?: Effort;
}

export type Effort = "S" | "M" | "L";

export interface SourceFile {
  /** Posix path relative to project root. */
  path: string;
  content: string;
}

export interface PackageInfo {
  /** Posix path of package.json relative to project root. */
  path: string;
  json: Record<string, any>;
}

export interface AuditContext {
  files: SourceFile[];
  packages: PackageInfo[];
}

export type Check = (ctx: AuditContext) => Finding[];

export interface AuditReport {
  generatedAt: string;
  projectRoot: string;
  summary: { high: number; medium: number; low: number; byCheck: Record<string, number> };
  findings: Finding[];
  /** Findings hidden because they are in the baseline file. */
  baselined?: number;
  /** Audited workspace packages (monorepo mode only). */
  packages?: string[];
}
