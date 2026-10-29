/**
 * Contract for the "wins" pipeline: measured graph -> edge-cut attribution -> classified wins -> outputs.
 * A "win" = one import edge that, if cut/deferred, removes bytes from a route's first-load client JS.
 */

export type FixKind = "lazy" | "move-to-server" | "swap-package" | "deep-import" | "remove";

export type Safety = "safe" | "needs-review";

export type SafetyReason =
  | "above-the-fold" // rendered unconditionally near top of page/layout
  | "needs-ssr" // component likely needed for first paint / SEO
  | "named-export" // next/dynamic needs .then(m => m.X) mapping
  | "no-default-export"
  | "already-in-suspense"
  | "shared-with-eager-route" // other routes keep it eager; saving is partial
  | "unresolved-usage"; // couldn't find JSX usage / handler usage

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
}

export interface EdgeCut {
  edge: EdgeRef;
  /** Shortest import chain from the route entry to `imported` (project-relative, entry first). */
  chain: string[];
  /** Bytes that leave this route's first-load JS if only this edge is cut (dominator-subtree bytes not reachable otherwise). */
  uniqueBytes: number;
  /** Total subtree bytes behind the imported module on this route (upper bound). */
  subtreeBytes: number;
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
}

export interface WinEdit {
  summary: string;
  /** e.g. "const Chart = dynamic(() => import('./Chart'), { ssr: false, loading: () => null })" */
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
