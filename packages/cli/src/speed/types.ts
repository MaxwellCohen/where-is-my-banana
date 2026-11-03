/** Contract for `wimb speed`: one merged, prioritized work plan (.wimb/plan.json). */

export type PlanSource = "audit" | "wins" | "live";
export type PlanOwner = "code" | "gtm" | "cdn" | "cms" | "human-decision";
export type Effort = "S" | "M" | "L";
export type PlanRisk = "safe" | "needs-review";
export type PlanSeverity = "high" | "medium" | "low";

export type Theme =
  | "Third parties"
  | "Rendering/caching"
  | "CMS blocks/registry"
  | "Images"
  | "Fonts"
  | "JS bundle"
  | "Payload"
  | "Dependencies"
  | "CSS";

export interface PlanItem {
  /** Stable across runs; used by --compare. */
  key: string;
  rank: number;
  source: PlanSource;
  /** All inputs that contributed (>1 means static + live/wins corroboration). */
  sources: PlanSource[];
  corroborated: boolean;
  theme: Theme;
  title: string;
  why: string;
  /** User-visible metrics affected, e.g. "LCP, INP, bytes". */
  impact: string;
  impactScore: number;
  effort: Effort;
  owner: PlanOwner;
  severity: PlanSeverity;
  /** Number of merged findings / locations. */
  count: number;
  files: string[];
  urls?: string[];
  exactInstructions: string[];
  verify: string;
  risk: PlanRisk;
  /** Estimated KB saved. basis "measured" only for bundle analysis; "rough" is a coarse heuristic. */
  estKB?: number;
  kbBasis?: "measured" | "estimated" | "rough";
}

export interface PageTypeRow {
  type: string;
  urls: number;
  high: number;
  medium: number;
  low: number;
  topIssue: string;
}

export interface PlanSummary {
  items: number;
  byOwner: Record<string, number>;
  byTheme: Record<string, number>;
  quickWins: number;
  budget: { theme: string; kb: number; basis: "measured" | "rough" | "mixed" }[];
  headline: string;
  biggestRisk?: string;
}

export interface PlanCompare {
  resolved: Pick<PlanItem, "key" | "title" | "theme">[];
  new: Pick<PlanItem, "key" | "title" | "theme" | "impactScore">[];
  regressed: { key: string; title: string; from: number; to: number; reason: string }[];
  unchanged: number;
}

export interface Plan {
  version: "1";
  generatedAt: string;
  projectRoot: string;
  inputs: { audit: boolean; wins: boolean; live: boolean };
  warnings: string[];
  summary: PlanSummary;
  items: PlanItem[];
  pageTypes?: PageTypeRow[];
  compare?: PlanCompare;
  agentPrompt: string;
}

/** Loosely-typed inputs: every field optional, shapes are owned by other modules. */
export interface RawFinding {
  id?: string;
  check?: string;
  severity?: string;
  file?: string;
  line?: number;
  url?: string;
  message?: string;
  fix?: string;
  evidence?: unknown;
  owner?: string;
  impactScore?: number;
  effort?: string;
  package?: string;
}
export interface RawAudit { findings?: RawFinding[] }
export interface RawLive { findings?: RawFinding[] }
export interface RawWin {
  id?: string;
  fixKind?: string;
  safety?: string;
  edge?: { importer?: string; imported?: string; packageName?: string | null };
  totalSavedBytes?: number;
  predictedSavedBytes?: number;
  safetyReasons?: string[];
  alsoReachableVia?: string[][];
  byteSource?: string;
  routes?: Record<string, number>;
  edit?: { summary?: string; replacementImport?: string; originalImport?: string; steps?: string[]; verify?: string };
}
export interface RawWins { wins?: RawWin[] }

export interface PlanInputs {
  audit?: RawAudit | null;
  wins?: RawWins | null;
  live?: RawLive | null;
}
