/**
 * Contract for the "wins" pipeline: measured graph -> edge-cut attribution -> classified wins -> outputs.
 * A "win" = one import edge that, if cut/deferred, removes bytes from a route's first-load client JS.
 */

export type FixKind = "lazy" | "move-to-server" | "swap-package" | "deep-import" | "remove" | "stub-alias";

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
  | "client-stub"; // stub-alias: breaks the client if it really calls the stubbed package

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
  routes: { route: string; firstLoadBytes: number }[];
  wins: Win[]; // ranked by totalSavedBytes desc, safe first on ties
}
