/** graph-v1 record types from next/analyze/graph-v1.schema.json */

export interface GraphMeta {
  type: "meta";
  schema_version: number;
  snapshot_name: string;
  module_index_hash: string;
  route_count: number;
  selected_routes: number;
}

export interface ModuleDependencies {
  sync: string[];
  async: string[];
  traced: string[];
}

export interface GraphModule {
  type: "module";
  ident: string;
  path: string;
  dependencies: ModuleDependencies;
}

export interface ClientReference {
  module_ident: string;
  module_path: string;
  reference_kind: "ecmascript" | "css";
}

export interface RouteEntry {
  route_entry_id: string;
  module_ident: string;
  module_path: string;
  role: "route" | "shared";
  entry_kind?: "server" | "client_bootstrap";
  client_references?: ClientReference[];
}

export interface GraphRoute {
  type: "route";
  route: string;
  entries: RouteEntry[] | null;
  coverage: {
    entries: "exact" | "unknown";
    groups: "exact" | "unknown";
  };
}

export interface GraphPart {
  type: "part";
  route: string;
  filename: string;
  source_path: string;
  size: number;
  compressed_size: number;
}

export interface GraphOutput {
  type: "output";
  route: string;
  filename: string;
  modules: string[];
  async_loaders: string[];
  coverage: "exact" | "unsupported" | "not_a_chunk";
}

export interface GraphGroup {
  type: "group";
  route: string;
  id: number;
  kind: string;
  trigger_module_ident: string | null;
  trigger_join: "joined" | "none";
  outputs: string[];
}

export type GraphRecord =
  | GraphMeta
  | GraphModule
  | GraphRoute
  | GraphPart
  | GraphOutput
  | GraphGroup
  | { type: string };

export type BundleSide = "client" | "server";

export interface ParsedGraph {
  meta: GraphMeta | null;
  modules: Map<string, GraphModule>;
  routes: Map<string, GraphRoute>;
  /** route → normalized source path → attributed client bytes */
  clientPartsByRoute: Map<string, Map<string, number>>;
  /** route → normalized source path → attributed server bytes */
  serverPartsByRoute: Map<string, Map<string, number>>;
  /** normalized path → set of routes with client attribution */
  pathRouteUsage: Map<string, Set<string>>;
  /** normalized path → set of routes with server attribution */
  serverPathRouteUsage: Map<string, Set<string>>;
  outputs: GraphOutput[];
  groups: GraphGroup[];
}

export type EdgeKind = "sync" | "async" | "client_reference" | "entry";

export interface TreeNode {
  kind: "route" | "module";
  /** Route path or module ident */
  id: string;
  label: string;
  path?: string;
  /** Attributed bytes for this module on this route (self). */
  selfBytes: number;
  /** Recursive sum of selfBytes under this node (including self). */
  totalBytes: number;
  /** How many routes include this module path in attribution for this side. */
  routeCount: number;
  edgeKind?: EdgeKind;
  cycle?: boolean;
  /** Already expanded elsewhere in this route tree — children omitted to avoid DAG blow-up. */
  shared?: boolean;
  children: TreeNode[];
}

export interface RouteSummary {
  route: string;
  totalBytes: number;
  moduleCount: number;
}

export interface VizSide {
  routes: RouteSummary[];
  trees: Record<string, TreeNode>;
  /**
   * App files ranked by import-graph pull weight (what they drag in), per route.
   * Prefer this over tree subtree totals — binary path trees are not import edges.
   */
  importersByRoute?: Record<string, ImporterRow[]>;
}

export interface VizGraph {
  schemaVersion: 1 | 2;
  meta: {
    snapshotName: string | null;
    routeCount: number;
    selectedRoutes: number;
  };
  /** Active default side (client). Kept for v1 compat / simple consumers. */
  routes: RouteSummary[];
  trees: Record<string, TreeNode>;
  /** Present on schemaVersion 2 — switch client/server in the UI. */
  sides?: {
    client: VizSide;
    server: VizSide;
  };
}

export interface BuildForestOptions {
  /** Include async dependency edges (default false). */
  includeAsync?: boolean;
  /** Include traced file-tracing deps (default false). */
  includeTraced?: boolean;
  /** Max walk depth from route roots (default 40). */
  maxDepth?: number;
  /** Which output side to attribute (default client). */
  side?: BundleSide;
}

export type DepReach = "sync" | "async" | "both";
export type DepKind = "package" | "app" | "next" | "other";

export interface ImporterDep {
  path: string;
  label: string;
  bytes: number;
  /** How this dep is reachable from the importer. */
  reach?: DepReach;
  /** Coarse classification for badges. */
  kind?: DepKind;
  /** Routes that attribute bytes to this module. */
  routeCount?: number;
}

export interface ImporterBadges {
  /** Routes where this file's import closure contributes weight. */
  routes: number;
  /** Direct sync import edges from this file. */
  sync: number;
  /** Direct async import edges from this file. */
  async: number;
  /** Modules in the attributed import closure (including self when attributed). */
  modules: number;
  /** Unique packages in the attributed closure. */
  packages: number;
}

export interface ImporterRow {
  path: string;
  label: string;
  selfBytes: number;
  /** Import-graph closure weight — what this file pulls in (including self). */
  pullBytes: number;
  routeCount: number;
  appFile: boolean;
  /** Counts for UI badges. */
  badges?: ImporterBadges;
  /** Heaviest deps in the import closure (excluding self). */
  topDeps?: ImporterDep[];
}
