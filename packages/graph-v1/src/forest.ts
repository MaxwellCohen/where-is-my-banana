import { displayLabel, normalizeModulePath } from "./module-path.js";
import type {
  BuildForestOptions,
  BundleSide,
  EdgeKind,
  ParsedGraph,
  RouteSummary,
  TreeNode,
  VizGraph,
  VizSide,
} from "./types.js";

const DEFAULT_MAX_DEPTH = 40;

function partsMap(graph: ParsedGraph, side: BundleSide) {
  return side === "server" ? graph.serverPartsByRoute : graph.clientPartsByRoute;
}

function usageMap(graph: ParsedGraph, side: BundleSide) {
  return side === "server" ? graph.serverPathRouteUsage : graph.pathRouteUsage;
}

function routeBytes(graph: ParsedGraph, route: string, side: BundleSide): number {
  const parts = partsMap(graph, side).get(route);
  if (!parts) return 0;
  let total = 0;
  for (const bytes of parts.values()) total += bytes;
  return total;
}

function selfBytesForPath(
  graph: ParsedGraph,
  route: string,
  path: string,
  side: BundleSide,
): number {
  return partsMap(graph, side).get(route)?.get(path) ?? 0;
}

function routeCountForPath(graph: ParsedGraph, path: string, side: BundleSide): number {
  return usageMap(graph, side).get(path)?.size ?? 0;
}

interface Seed {
  ident: string;
  edgeKind: EdgeKind;
}

function collectSeeds(graph: ParsedGraph, routePath: string, side: BundleSide): Seed[] {
  const route = graph.routes.get(routePath);
  const seeds: Seed[] = [];
  const seen = new Set<string>();

  const push = (ident: string, edgeKind: EdgeKind) => {
    if (!ident || seen.has(ident)) return;
    seen.add(ident);
    seeds.push({ ident, edgeKind });
  };

  if (route?.entries) {
    const clientRefs: Seed[] = [];
    const bootstraps: Seed[] = [];
    const serverEntries: Seed[] = [];
    const routeEntries: Seed[] = [];

    for (const entry of route.entries) {
      if (entry.entry_kind === "client_bootstrap") {
        bootstraps.push({ ident: entry.module_ident, edgeKind: "entry" });
      } else if (entry.entry_kind === "server") {
        serverEntries.push({ ident: entry.module_ident, edgeKind: "entry" });
      } else if (entry.role === "route") {
        routeEntries.push({ ident: entry.module_ident, edgeKind: "entry" });
      }
      for (const ref of entry.client_references ?? []) {
        if (ref.reference_kind === "ecmascript") {
          clientRefs.push({ ident: ref.module_ident, edgeKind: "client_reference" });
        }
      }
    }

    const preferred =
      side === "client"
        ? clientRefs.length > 0 || bootstraps.length > 0
          ? [...bootstraps, ...clientRefs]
          : routeEntries
        : serverEntries.length > 0
          ? serverEntries
          : routeEntries;

    for (const seed of preferred) push(seed.ident, seed.edgeKind);
  }

  if (seeds.length === 0) {
    const parts = partsMap(graph, side).get(routePath);
    if (parts) {
      const pathToIdents = new Map<string, string[]>();
      for (const mod of graph.modules.values()) {
        const p = normalizeModulePath(mod.path);
        if (!p) continue;
        let list = pathToIdents.get(p);
        if (!list) {
          list = [];
          pathToIdents.set(p, list);
        }
        list.push(mod.ident);
      }
      for (const path of parts.keys()) {
        for (const ident of pathToIdents.get(path) ?? []) {
          push(ident, "entry");
        }
      }
    }
  }

  return seeds;
}

function leafNode(
  ident: string,
  path: string,
  label: string,
  selfBytes: number,
  routeCount: number,
  edgeKind: EdgeKind,
  flags: { cycle?: boolean; shared?: boolean } = {},
): TreeNode {
  return {
    kind: "module",
    id: ident,
    label,
    path,
    selfBytes,
    totalBytes: selfBytes,
    routeCount,
    edgeKind,
    cycle: flags.cycle,
    shared: flags.shared,
    children: [],
  };
}

function walkModule(
  graph: ParsedGraph,
  routePath: string,
  ident: string,
  edgeKind: EdgeKind,
  ancestors: Set<string>,
  depth: number,
  opts: Required<BuildForestOptions>,
  expanded: Set<string>,
): TreeNode {
  const side = opts.side;
  const mod = graph.modules.get(ident);
  const path = normalizeModulePath(mod?.path ?? ident);
  const label = displayLabel(path);
  const selfBytes = selfBytesForPath(graph, routePath, path, side);
  const routeCount = routeCountForPath(graph, path, side);

  if (ancestors.has(ident)) {
    return leafNode(ident, path, label, selfBytes, routeCount, edgeKind, { cycle: true });
  }

  if (expanded.has(ident)) {
    return leafNode(ident, path, label, selfBytes, routeCount, edgeKind, { shared: true });
  }

  if (depth >= opts.maxDepth || !mod) {
    return leafNode(ident, path, label, selfBytes, routeCount, edgeKind);
  }

  expanded.add(ident);

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(ident);

  const children: TreeNode[] = [];
  const childIdents: Array<{ ident: string; edgeKind: EdgeKind }> = [];

  for (const dep of mod.dependencies.sync) {
    childIdents.push({ ident: dep, edgeKind: "sync" });
  }
  if (opts.includeAsync) {
    for (const dep of mod.dependencies.async) {
      childIdents.push({ ident: dep, edgeKind: "async" });
    }
  }
  if (opts.includeTraced) {
    for (const dep of mod.dependencies.traced) {
      childIdents.push({ ident: dep, edgeKind: "sync" });
    }
  }

  const seenChild = new Set<string>();
  for (const child of childIdents) {
    if (seenChild.has(child.ident)) continue;
    seenChild.add(child.ident);
    children.push(
      walkModule(
        graph,
        routePath,
        child.ident,
        child.edgeKind,
        nextAncestors,
        depth + 1,
        opts,
        expanded,
      ),
    );
  }

  children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));

  const totalBytes =
    selfBytes + children.reduce((sum, c) => sum + (c.shared || c.cycle ? 0 : c.totalBytes), 0);

  return {
    kind: "module",
    id: ident,
    label,
    path,
    selfBytes,
    totalBytes,
    routeCount,
    edgeKind,
    children,
  };
}

/** Build a single route-rooted tree. */
export function buildRouteTree(
  graph: ParsedGraph,
  routePath: string,
  options: BuildForestOptions = {},
): TreeNode {
  const opts: Required<BuildForestOptions> = {
    includeAsync: options.includeAsync ?? false,
    includeTraced: options.includeTraced ?? false,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    side: options.side ?? "client",
  };

  const seeds = collectSeeds(graph, routePath, opts.side);
  const children: TreeNode[] = [];
  const seenRoot = new Set<string>();
  const expanded = new Set<string>();

  for (const seed of seeds) {
    if (seenRoot.has(seed.ident)) continue;
    seenRoot.add(seed.ident);
    children.push(
      walkModule(graph, routePath, seed.ident, seed.edgeKind, new Set(), 0, opts, expanded),
    );
  }

  if (children.length === 0) {
    const parts = partsMap(graph, opts.side).get(routePath);
    if (parts) {
      for (const [path, bytes] of parts) {
        children.push({
          kind: "module",
          id: path,
          label: displayLabel(path),
          path,
          selfBytes: bytes,
          totalBytes: bytes,
          routeCount: routeCountForPath(graph, path, opts.side),
          edgeKind: "entry",
          children: [],
        });
      }
    }
  }

  children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));

  const totalBytes = routeBytes(graph, routePath, opts.side);
  return {
    kind: "route",
    id: routePath,
    label: routePath,
    selfBytes: 0,
    totalBytes,
    routeCount: 1,
    children,
  };
}

function countModules(node: TreeNode): number {
  if (node.kind === "module") {
    return 1 + node.children.reduce((n, c) => n + countModules(c), 0);
  }
  return node.children.reduce((n, c) => n + countModules(c), 0);
}

function buildSide(graph: ParsedGraph, options: BuildForestOptions, side: BundleSide): VizSide {
  const trees: Record<string, TreeNode> = {};
  const routes: RouteSummary[] = [];
  const routePaths = [...graph.routes.keys()].sort();
  for (const routePath of routePaths) {
    const tree = buildRouteTree(graph, routePath, { ...options, side });
    trees[routePath] = tree;
    routes.push({
      route: routePath,
      totalBytes: tree.totalBytes,
      moduleCount: countModules(tree),
    });
  }
  routes.sort((a, b) => b.totalBytes - a.totalBytes || a.route.localeCompare(b.route));
  return { routes, trees };
}

/** Build the viz payload: route summaries + per-route trees (client side by default). */
export function buildRouteForest(
  graph: ParsedGraph,
  options: BuildForestOptions = {},
): VizGraph {
  const side = options.side ?? "client";
  const primary = buildSide(graph, options, side);
  return {
    schemaVersion: 1,
    meta: {
      snapshotName: graph.meta?.snapshot_name ?? null,
      routeCount: graph.meta?.route_count ?? primary.routes.length,
      selectedRoutes: graph.meta?.selected_routes ?? primary.routes.length,
    },
    routes: primary.routes,
    trees: primary.trees,
  };
}

/** Build client + server forests for the visualizer side filter. */
export function buildDualRouteForest(
  graph: ParsedGraph,
  options: BuildForestOptions = {},
): VizGraph {
  const client = buildSide(graph, options, "client");
  const server = buildSide(graph, options, "server");
  return {
    schemaVersion: 2,
    meta: {
      snapshotName: graph.meta?.snapshot_name ?? null,
      routeCount: graph.meta?.route_count ?? Math.max(client.routes.length, server.routes.length),
      selectedRoutes:
        graph.meta?.selected_routes ?? Math.max(client.routes.length, server.routes.length),
    },
    routes: client.routes,
    trees: client.trees,
    sides: { client, server },
  };
}
