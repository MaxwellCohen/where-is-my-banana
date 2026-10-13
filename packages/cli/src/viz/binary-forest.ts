import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BundleSide, TreeNode, VizGraph, VizSide } from "@wimb/graph-v1";
import { displayLabel, normalizeModulePath, packageNameFromPath } from "@wimb/graph-v1";
import {
  buildFullPaths,
  parseDataFile,
  readEdgesAtIndex,
  type AnalyzeRouteHeader,
} from "../build/binary-format.js";
import { discoverRouteAnalyzeFiles } from "../build/analyze.js";
import { rankBinaryImportersByRoute } from "./binary-importers.js";

interface SourceAttrs {
  path: string;
  clientBytes: number;
  serverBytes: number;
  children: number[];
}

function classifyOutput(filename: string): "client" | "server" | "other" {
  if (!filename.endsWith(".js")) return "other";
  if (filename.startsWith("[client-fs]/")) return "client";
  return "server";
}

function loadRouteSources(filePath: string): {
  attrs: SourceAttrs[];
  roots: number[];
} | null {
  try {
    const { header, binary } = parseDataFile<AnalyzeRouteHeader>(readFileSync(filePath));
    const sources = header.sources ?? [];
    const fullPaths = buildFullPaths(sources);
    const chunkParts = header.chunk_parts ?? [];
    const outputFiles = header.output_files ?? [];

    const attrs: SourceAttrs[] = sources.map((_, i) => {
      const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
      let clientCompressed = 0;
      let clientSize = 0;
      let serverCompressed = 0;
      let serverSize = 0;
      let sawClient = false;
      let sawServer = false;

      for (const cpIdx of partIndices) {
        const cp = chunkParts[cpIdx];
        if (!cp) continue;
        const of = outputFiles[cp.output_file_index];
        const kind = classifyOutput(of?.filename ?? "");
        if (kind === "client") {
          sawClient = true;
          clientCompressed += cp.compressed_size;
          clientSize += cp.size;
        } else if (kind === "server") {
          sawServer = true;
          serverCompressed += cp.compressed_size;
          serverSize += cp.size;
        }
      }

      // If this route has no client-tagged outputs at all, treat all JS as client fallback
      // (matches prior attribution behavior for older fixtures).
      if (!sawClient && !sawServer) {
        for (const cpIdx of partIndices) {
          const cp = chunkParts[cpIdx];
          if (!cp) continue;
          clientCompressed += cp.compressed_size;
          clientSize += cp.size;
        }
      }

      return {
        path: normalizeModulePath(fullPaths[i] ?? sources[i]?.path ?? ""),
        clientBytes: sawClient || (!sawClient && !sawServer)
          ? clientCompressed > 0
            ? clientCompressed
            : clientSize
          : 0,
        serverBytes: sawServer ? (serverCompressed > 0 ? serverCompressed : serverSize) : 0,
        children: readEdgesAtIndex(binary, header.source_children, i),
      };
    });

    const roots =
      header.source_roots && header.source_roots.length > 0 ? header.source_roots : [0];

    return { attrs, roots };
  } catch {
    return null;
  }
}

function walkSource(
  attrs: SourceAttrs[],
  index: number,
  side: BundleSide,
  pathRouteUsage: Map<string, Set<string>>,
  ancestors: Set<number>,
  expanded: Set<number>,
): TreeNode {
  const src = attrs[index];
  const path = src?.path || `source:${index}`;
  const label = displayLabel(path) || path;
  const selfBytes = side === "client" ? (src?.clientBytes ?? 0) : (src?.serverBytes ?? 0);
  const routeCount = pathRouteUsage.get(path)?.size ?? 0;

  if (ancestors.has(index)) {
    return {
      kind: "module",
      id: path,
      label,
      path,
      selfBytes,
      totalBytes: selfBytes,
      routeCount,
      edgeKind: "sync",
      cycle: true,
      children: [],
    };
  }

  if (expanded.has(index)) {
    return {
      kind: "module",
      id: path,
      label,
      path,
      selfBytes,
      totalBytes: selfBytes,
      routeCount,
      edgeKind: "sync",
      shared: true,
      children: [],
    };
  }

  expanded.add(index);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(index);

  const children: TreeNode[] = [];
  const seenChild = new Set<number>();
  for (const childIdx of src?.children ?? []) {
    if (seenChild.has(childIdx)) continue;
    seenChild.add(childIdx);
    if (childIdx < 0 || childIdx >= attrs.length) continue;
    children.push(walkSource(attrs, childIdx, side, pathRouteUsage, nextAncestors, expanded));
  }

  children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));

  const totalBytes =
    selfBytes + children.reduce((sum, c) => sum + (c.shared || c.cycle ? 0 : c.totalBytes), 0);

  return {
    kind: "module",
    id: path,
    label,
    path,
    selfBytes,
    totalBytes,
    routeCount,
    edgeKind: "entry",
    children,
  };
}

function countModules(node: TreeNode): number {
  if (node.kind === "module") {
    return 1 + node.children.reduce((n, c) => n + countModules(c), 0);
  }
  return node.children.reduce((n, c) => n + countModules(c), 0);
}

function buildSideFromLoaded(
  loaded: Map<string, { attrs: SourceAttrs[]; roots: number[] }>,
  side: BundleSide,
): VizSide {
  const pathRouteUsage = new Map<string, Set<string>>();

  for (const [route, parsed] of loaded) {
    for (const src of parsed.attrs) {
      const bytes = side === "client" ? src.clientBytes : src.serverBytes;
      if (!src.path || bytes <= 0) continue;
      let usage = pathRouteUsage.get(src.path);
      if (!usage) {
        usage = new Set();
        pathRouteUsage.set(src.path, usage);
      }
      usage.add(route);

      const pkg = packageNameFromPath(src.path);
      if (pkg) {
        let pkgUsage = pathRouteUsage.get(pkg);
        if (!pkgUsage) {
          pkgUsage = new Set();
          pathRouteUsage.set(pkg, pkgUsage);
        }
        pkgUsage.add(route);
      }
    }
  }

  const trees: Record<string, TreeNode> = {};
  const routes: VizSide["routes"] = [];

  for (const [route, parsed] of [...loaded.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const expanded = new Set<number>();
    const children: TreeNode[] = [];
    for (const root of parsed.roots) {
      if (root < 0 || root >= parsed.attrs.length) continue;
      children.push(walkSource(parsed.attrs, root, side, pathRouteUsage, new Set(), expanded));
    }
    children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));

    let routeTotal = 0;
    for (const a of parsed.attrs) {
      routeTotal += side === "client" ? a.clientBytes : a.serverBytes;
    }

    const tree: TreeNode = {
      kind: "route",
      id: route,
      label: route,
      selfBytes: 0,
      totalBytes: routeTotal,
      routeCount: 1,
      children,
    };
    trees[route] = tree;
    routes.push({
      route,
      totalBytes: routeTotal,
      moduleCount: countModules(tree),
    });
  }

  routes.sort((a, b) => b.totalBytes - a.totalBytes || a.route.localeCompare(b.route));
  return { routes, trees };
}

/**
 * Build a viz forest from Next `experimental-analyze --output` binary data
 * under `.next/diagnostics/analyze/data/` (no `analyze export` / Next 16.4+ required).
 */
export function buildRouteForestFromBinary(dataDir: string): VizGraph {
  const routeFiles = discoverRouteAnalyzeFiles(dataDir);
  const loaded = new Map<string, { attrs: SourceAttrs[]; roots: number[] }>();

  for (const { route, filePath } of routeFiles) {
    const parsed = loadRouteSources(filePath);
    if (!parsed) continue;
    loaded.set(route, parsed);
  }

  const routesJson = join(dataDir, "routes.json");
  if (existsSync(routesJson)) {
    try {
      const listed = JSON.parse(readFileSync(routesJson, "utf-8")) as string[];
      for (const route of listed) {
        if (!loaded.has(route)) {
          loaded.set(route, { attrs: [], roots: [] });
        }
      }
    } catch {
      // ignore
    }
  }

  const client = buildSideFromLoaded(loaded, "client");
  const server = buildSideFromLoaded(loaded, "server");
  client.importersByRoute = rankBinaryImportersByRoute(dataDir, "client");
  server.importersByRoute = rankBinaryImportersByRoute(dataDir, "server");

  return {
    schemaVersion: 2,
    meta: {
      snapshotName: "experimental-analyze",
      routeCount: Math.max(client.routes.length, server.routes.length),
      selectedRoutes: Math.max(client.routes.length, server.routes.length),
    },
    routes: client.routes,
    trees: client.trees,
    sides: { client, server },
  };
}
