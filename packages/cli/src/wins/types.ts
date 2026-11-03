/**
 * Contract for the "wins" pipeline: measured graph -> edge-cut attribution -> classified wins -> outputs.
 * A "win" = one import edge that, if cut/deferred, removes bytes from a route's first-load client JS.
 */

export type FixKind = "lazy" | "move-to-server" | "swap-package" | "deep-import" | "remove" | "stub-alias" | "guard-heavy";

export type Safety = "safe" | "needs-review";

export type SafetyReason =
  | "above-the-fold" // rendered unconditionally near top of page/layout
  | "needs-ssr" // component likely needed for first paint / SEO
  | "named-export" // next/dynamic needs .then(m => m.X) mapping
  | "no-default-export"
  | "already-in-suspense"
  | "shared-with-eager-route" // other routes keep it eager; saving is partial
  | "unresolved-usage" // couldn't find JSX usage / handler usage
  | "static-elsewhere" // imported module stays reachable through another static import chain
  | "net-negative-risk" // predicted saving is <= 0 or too small to outweigh the lazy-loading runtime
  | "client-stub" // stub-alias: breaks the client if it really calls the stubbed package
  | "behavior-change" // guard-heavy: pre-check path must produce the same output as the library
  | "barrel-defeats-lazy" // the module stays statically reachable through a barrel re-export
  | "failed-previously"; // `wimb verify` reverted this win earlier

/** How likely the predicted saving is realized after the fix. */
export type Confidence = "high" | "medium" | "low";

export type UsageKind =
  | "conditional-render" // inside if/ternary/&&
  | "event-handler-only" // only referenced inside event handlers
  | "always-rendered"
  | "unknown";

/** Edge in the module graph: importer -> imported (client side, sync). */
export interface EdgeRef {
  importer: string; // project-relative path (normalized)
  imported: string; // project-relative path or package path (node_modules/...)
  packageName: string | null;
}

/** Per-route output of attribution (stage A). */
export interface RouteAttribution {
  route: string;
  /** compressed bytes of first-load client JS for the route */
  firstLoadBytes: number;
  measured: boolean;
  /** one entry per candidate edge, sorted by uniqueBytes desc */
  edges: EdgeCut[];
  /** the route already ships next/dynamic (or equivalent) runtime, so lazy() costs nothing extra */
  hasDynamicRuntime?: boolean;
  /** extra bytes of dynamic chunks Next still preloads on this route (server-rendered, unconditional dynamic edges) */
  preloadedBytes?: number;
  /** bytes of dynamic chunks fetched only on demand (conditional / handler-only / ssr:false) */
  onDemandBytes?: number;
}

export interface EdgeCut {
  edge: EdgeRef;
  /** Shortest import chain from the route entry to `imported` (project-relative, entry first). */
  chain: string[];
  /** Bytes that leave this route's first-load JS if only this edge is cut (dominator-subtree bytes not reachable otherwise). */
  uniqueBytes: number;
  /** Total subtree bytes behind the imported module on this route (upper bound). */
  subtreeBytes: number;
  /** Other static import chains (not through this edge) that still reach the same module; up to 3. */
  alsoReachableVia?: string[][];
  /** source location of the import statement in importer, if known */
  loc?: { line: number; column: number };
}

/** Classified, ranked recommendation (stage B). */
export interface Win {
  id: string; // stable: `${fixKind}:${importer}:${imported}`
  fixKind: FixKind;
  safety: Safety;
  safetyReasons: SafetyReason[];
  usage: UsageKind;
  edge: EdgeRef;
  loc?: { line: number; column: number };
  /** where the imported binding is used (JSX / handler), if found */
  usageLoc?: { line: number; column: number };
  /** per-route savings: route -> uniqueBytes (compressed if measured) */
  routes: Record<string, number>;
  /** bytes saved only if ALL listed routes are fixed (sum of unique across routes, de-duplicated by shared chunk = max) */
  totalSavedBytes: number;
  byteSource: "measured" | "estimated";
  chain: string[];
  /** concrete, agent-ready edit */
  edit: WinEdit;
  /** Other static chains that keep the imported module in the route even after this edge is cut (up to 3). */
  alsoReachableVia?: string[][];
  /** totalSavedBytes minus runtime cost of the fix (e.g. next/dynamic); what to expect after rebuilding. */
  predictedSavedBytes?: number;
  confidence?: Confidence;
  /** stub-alias only */
  stub?: StubInfo;
  /** lazy only: bytes that move from first-load to preloaded (always-rendered, server-rendered component) instead of leaving the page */
  movesToPreloadedBytes?: number;
  /** set by `wins` when `.wimb/verify.json` records a failed attempt of this win */
  status?: "failed-previously";
  /** barrel re-export that keeps the target statically reachable */
  barrel?: BarrelWinInfo;
  /** tests that exercise the affected component (lazy / guard-heavy wins) */
  testImpact?: TestImpact;
}

export interface BarrelWinInfo {
  barrel: string;
  /** first-party files importing the barrel on the static path, with import line */
  importers: { file: string; line?: number }[];
}

export interface TestImpact {
  files: string[];
  warnings: string[];
  runner: "vitest" | "jest" | null;
  /** command to run just these tests */
  command?: string;
  /** optional setup snippet that makes next/dynamic resolve eagerly in tests */
  setupMock?: string;
}

/** Dynamic chunk classification for one route. */
export interface DynamicEdgeInfo {
  importer: string;
  imported: string;
  /** bytes of the dynamic chunk(s) behind this edge not already in first-load */
  bytes: number;
  kind: "preloaded" | "on-demand";
  reason: string;
}

export interface BarrelFinding {
  /** module that is meant to be lazy (or is lazy-loaded already) */
  target: string;
  barrel: string;
  /** "already-lazy": a dynamic import() target that is also reachable statically; "proposed-lazy": a lazy win is blocked */
  kind: "already-lazy" | "proposed-lazy";
  chain: string[];
  routes: string[];
  importers: { file: string; line?: number }[];
  fix: string;
}

export interface PackageRow {
  package: string;
  /** compressed bytes in the largest route's first-load */
  bytes: number;
  /** share of that route's first-load JS, 0..100 */
  pct: number;
  routes: number;
  /** first-party file that pulls the package in (most bytes) */
  topImporter: string | null;
}

export interface ValidationRoute {
  route: string;
  status: "ok" | "flagged" | "no-html";
  source?: "file" | "url";
  htmlPath?: string;
  graphFirstLoadBytes: number;
  graphPreloadedBytes?: number;
  htmlScriptRawBytes: number;
  htmlScriptGzipBytes: number;
  htmlPreloadGzipBytes: number;
  scriptCount: number;
  preloadCount: number;
  /** (html gzip - graph) / graph, signed fraction */
  diff: number | null;
  reasons: string[];
  missing: string[];
}

export interface ValidationReport {
  tolerance: number;
  routes: ValidationRoute[];
  flagged: number;
}

export interface StubInfo {
  package: string;
  /** the sideEffects:false package(s) whose modules pull it in */
  via: string[];
  signals: string[];
  stubPath: string;
  stubContent: string;
  turbopackConfig: string;
  webpackConfig: string;
}

export interface WinEdit {
  summary: string;
  /** e.g. "const Chart = dynamic(() => import('./Chart'), { loading: () => null })" */
  replacementImport?: string;
  /** pattern for the original import line to remove/replace */
  originalImport?: string;
  steps: string[];
  verify: string; // shell command(s) to confirm byte delta
}

export interface WinsReport {
  version: "2";
  timestamp: string;
  projectRoot: string;
  byteSource: "measured" | "estimated";
  routes: { route: string; firstLoadBytes: number; preloadedBytes?: number; onDemandBytes?: number }[];
  wins: Win[]; // ranked by totalSavedBytes desc, safe first on ties
  /** top node_modules packages in client first-load (optional; absent in older reports) */
  packages?: PackageRow[];
  /** barrels that keep lazy-load targets statically reachable (optional) */
  barrels?: BarrelFinding[];
  /** per-route dynamic edges seen by the lazy accounting (optional) */
  dynamicEdges?: Record<string, DynamicEdgeInfo[]>;
  /** result of `wimb validate` (optional) */
  validation?: ValidationReport;
}
