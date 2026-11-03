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
  "split-candidate",
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
  /** Structured facts behind the finding (split-candidate only). */
  evidence?: SplitEvidence;
}

export interface SplitCluster {
  name: string;
  declarations: string[];
  loc: number;
  imports: string[];
  /** Heavy packages only this cluster uses. */
  heavy: string[];
  interactive: boolean;
}

export interface SplitEvidence {
  loc: number;
  declarations: number;
  exports: number;
  imports: number;
  packages: number;
  client: boolean;
  clientReachable: boolean;
  hooks: number;
  jsxNodes: number;
  /** LOC share of the largest cluster, 1 = fully cohesive. */
  cohesion: number;
  clusters: SplitCluster[];
  uniqueHeavy: string[];
  triggers: string[];
  /** Measured gzip-agnostic KB of the unique heavy packages (from .wimb/bundle-graph.json), when available. */
  measuredKB?: number;
  serverEligibleLoc?: number;
}

export interface SplitThresholds {
  splitMinLoc: number;
  splitMinClusterLoc: number;
  splitGodFileLoc: number;
  splitGodFileDecls: number;
  splitGodFileImports: number;
  splitServerEligibleLoc: number;
  splitRegistryMinImports: number;
  splitHeavyKb: number;
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
  /** split-candidate threshold overrides. */
  split?: Partial<SplitThresholds>;
  /** Measured bytes per npm package (from .wimb/bundle-graph.json). */
  measured?: Record<string, number>;
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
