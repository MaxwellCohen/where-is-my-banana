import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BundleSide,
  DepKind,
  DepReach,
  ImporterBadges,
  ImporterDep,
  ImporterRow,
} from "@wimb/graph-v1";
import {
  displayLabel,
  isAppSourcePath,
  normalizeModulePath,
  packageNameFromPath,
} from "@wimb/graph-v1";
import {
  buildFullPaths,
  parseDataFile,
  readEdgesAtIndex,
  type AnalyzeRouteHeader,
  type ModulesHeader,
} from "../build/binary-format.js";
import { discoverRouteAnalyzeFiles } from "../build/analyze.js";

interface ModuleIndex {
  modules: { ident?: string; path?: string }[];
  pathToIndices: Map<string, number[]>;
  depsRef: ModulesHeader["module_dependencies"];
  asyncDepsRef: ModulesHeader["async_module_dependencies"];
  binary: DataView;
}

function loadModuleIndex(dataDir: string): ModuleIndex | null {
  const modulesPath = join(dataDir, "modules.data");
  if (!existsSync(modulesPath)) return null;
  try {
    const { header, binary } = parseDataFile<ModulesHeader>(readFileSync(modulesPath));
    const modules = header.modules ?? [];
    const pathToIndices = new Map<string, number[]>();
    for (let i = 0; i < modules.length; i++) {
      const path = normalizeModulePath(modules[i]?.path ?? "");
      if (!path) continue;
      let list = pathToIndices.get(path);
      if (!list) {
        list = [];
        pathToIndices.set(path, list);
      }
      list.push(i);
    }
    return {
      modules,
      pathToIndices,
      depsRef: header.module_dependencies,
      asyncDepsRef: header.async_module_dependencies,
      binary,
    };
  } catch {
    return null;
  }
}

function classifyOutput(filename: string): "client" | "server" | "other" {
  if (!filename.endsWith(".js")) return "other";
  if (filename.startsWith("[client-fs]/")) return "client";
  return "server";
}

function routePathBytes(filePath: string, side: BundleSide): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const { header, binary } = parseDataFile<AnalyzeRouteHeader>(readFileSync(filePath));
    const sources = header.sources ?? [];
    const chunkParts = header.chunk_parts ?? [];
    const outputFiles = header.output_files ?? [];
    const fullPaths = buildFullPaths(sources);

    let anyClient = false;
    let anyServer = false;
    const clientBytes = new Array<number>(sources.length).fill(0);
    const serverBytes = new Array<number>(sources.length).fill(0);

    for (let i = 0; i < sources.length; i++) {
      const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
      let cComp = 0;
      let cSize = 0;
      let sComp = 0;
      let sSize = 0;
      for (const cpIdx of partIndices) {
        const cp = chunkParts[cpIdx];
        if (!cp) continue;
        const kind = classifyOutput(outputFiles[cp.output_file_index]?.filename ?? "");
        if (kind === "client") {
          anyClient = true;
          cComp += cp.compressed_size;
          cSize += cp.size;
        } else if (kind === "server") {
          anyServer = true;
          sComp += cp.compressed_size;
          sSize += cp.size;
        }
      }
      clientBytes[i] = cComp > 0 ? cComp : cSize;
      serverBytes[i] = sComp > 0 ? sComp : sSize;
    }

    if (!anyClient && !anyServer) {
      for (let i = 0; i < sources.length; i++) {
        const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
        let size = 0;
        let compressed = 0;
        for (const cpIdx of partIndices) {
          const cp = chunkParts[cpIdx];
          if (!cp) continue;
          size += cp.size;
          compressed += cp.compressed_size;
        }
        clientBytes[i] = compressed > 0 ? compressed : size;
      }
    }

    for (let i = 0; i < sources.length; i++) {
      const path = normalizeModulePath(fullPaths[i] ?? "");
      if (!path) continue;
      const bytes = side === "client" ? clientBytes[i]! : serverBytes[i]!;
      if (bytes <= 0) continue;
      out.set(path, (out.get(path) ?? 0) + bytes);
    }
  } catch {
    // skip malformed route
  }
  return out;
}

function depLabel(path: string): string {
  return packageNameFromPath(path) ?? displayLabel(path);
}

function depKind(path: string): DepKind {
  if (isAppSourcePath(path)) return "app";
  const pkg = packageNameFromPath(path);
  if (pkg === "next" || path.includes("/next/dist/") || path.startsWith("next/")) return "next";
  if (pkg) return "package";
  return "other";
}

interface ClosureResult {
  pullBytes: number;
  topDeps: ImporterDep[];
  badges: Omit<ImporterBadges, "routes">;
}

function closurePull(
  index: ModuleIndex,
  startPath: string,
  pathBytes: Map<string, number>,
  pathRouteUsage: Map<string, Set<string>>,
): ClosureResult {
  const starts = index.pathToIndices.get(startPath) ?? [];
  if (starts.length === 0) {
    const self = pathBytes.get(startPath) ?? 0;
    return {
      pullBytes: self,
      topDeps: [],
      badges: { sync: 0, async: 0, modules: self > 0 ? 1 : 0, packages: 0 },
    };
  }

  // Direct edge counts from this file's module variants.
  let directSync = 0;
  let directAsync = 0;
  for (const i of starts) {
    directSync += readEdgesAtIndex(index.binary, index.depsRef, i).length;
    directAsync += readEdgesAtIndex(index.binary, index.asyncDepsRef, i).length;
  }

  // BFS with reach tagging: sync-only vs async-touched.
  const syncReach = new Set<number>();
  const asyncReach = new Set<number>();
  const syncQueue = [...starts];
  while (syncQueue.length > 0) {
    const i = syncQueue.pop()!;
    if (syncReach.has(i)) continue;
    syncReach.add(i);
    for (const d of readEdgesAtIndex(index.binary, index.depsRef, i)) {
      if (!syncReach.has(d)) syncQueue.push(d);
    }
  }

  const asyncQueue: number[] = [];
  for (const i of starts) {
    for (const d of readEdgesAtIndex(index.binary, index.asyncDepsRef, i)) {
      asyncQueue.push(d);
    }
  }
  // Async edges deeper in the sync tree also count as async-touched targets.
  for (const i of syncReach) {
    if (starts.includes(i)) continue;
    for (const d of readEdgesAtIndex(index.binary, index.asyncDepsRef, i)) {
      asyncQueue.push(d);
    }
  }
  while (asyncQueue.length > 0) {
    const i = asyncQueue.pop()!;
    if (asyncReach.has(i)) continue;
    asyncReach.add(i);
    for (const d of readEdgesAtIndex(index.binary, index.depsRef, i)) {
      if (!asyncReach.has(d)) asyncQueue.push(d);
    }
    for (const d of readEdgesAtIndex(index.binary, index.asyncDepsRef, i)) {
      if (!asyncReach.has(d)) asyncQueue.push(d);
    }
  }

  const all = new Set<number>([...syncReach, ...asyncReach]);
  const pathReach = new Map<string, DepReach>();
  const packages = new Set<string>();

  for (const i of all) {
    const p = normalizeModulePath(index.modules[i]?.path ?? "");
    if (!p) continue;
    const viaSync = syncReach.has(i);
    const viaAsync = asyncReach.has(i);
    const reach: DepReach = viaSync && viaAsync ? "both" : viaAsync ? "async" : "sync";
    const prev = pathReach.get(p);
    if (!prev) pathReach.set(p, reach);
    else if (prev !== reach) pathReach.set(p, "both");

    const pkg = packageNameFromPath(p);
    if (pkg) packages.add(pkg);
  }

  let pullBytes = 0;
  let attributedModules = 0;
  const deps: ImporterDep[] = [];
  for (const [p, reach] of pathReach) {
    const bytes = pathBytes.get(p) ?? 0;
    if (bytes <= 0) continue;
    pullBytes += bytes;
    attributedModules += 1;
    if (p === startPath) continue;
    deps.push({
      path: p,
      label: depLabel(p),
      bytes,
      reach,
      kind: depKind(p),
      routeCount: pathRouteUsage.get(p)?.size ?? 0,
    });
  }
  deps.sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));

  return {
    pullBytes,
    topDeps: deps.slice(0, 10),
    badges: {
      sync: directSync,
      async: directAsync,
      modules: attributedModules,
      packages: packages.size,
    },
  };
}

/**
 * Rank app-owned files by what their import graph pulls into each route.
 * Uses modules.data edges — not the path-segment source_children tree.
 */
export function rankBinaryImportersByRoute(
  dataDir: string,
  side: BundleSide,
): Record<string, ImporterRow[]> {
  const index = loadModuleIndex(dataDir);
  if (!index) return {};

  const routeFiles = discoverRouteAnalyzeFiles(dataDir);
  const pathRouteUsage = new Map<string, Set<string>>();
  const perRouteBytes = new Map<string, Map<string, number>>();

  for (const { route, filePath } of routeFiles) {
    const pathBytes = routePathBytes(filePath, side);
    perRouteBytes.set(route, pathBytes);
    for (const [path, bytes] of pathBytes) {
      if (bytes <= 0) continue;
      let usage = pathRouteUsage.get(path);
      if (!usage) {
        usage = new Set();
        pathRouteUsage.set(path, usage);
      }
      usage.add(route);
    }
  }

  const out: Record<string, ImporterRow[]> = {};
  const pullRouteUsage = new Map<string, Set<string>>();

  for (const [route, pathBytes] of perRouteBytes) {
    const candidates = new Set<string>([...pathBytes.keys(), ...index.pathToIndices.keys()]);
    const rows: ImporterRow[] = [];

    for (const path of candidates) {
      if (!isAppSourcePath(path)) continue;
      const { pullBytes, topDeps, badges } = closurePull(
        index,
        path,
        pathBytes,
        pathRouteUsage,
      );
      if (pullBytes <= 0) continue;
      const selfBytes = pathBytes.get(path) ?? 0;
      let usage = pullRouteUsage.get(path);
      if (!usage) {
        usage = new Set();
        pullRouteUsage.set(path, usage);
      }
      usage.add(route);
      rows.push({
        path,
        label: displayLabel(path),
        selfBytes,
        pullBytes,
        routeCount: 0,
        appFile: true,
        badges: { ...badges, routes: 0 },
        topDeps,
      });
    }

    rows.sort(
      (a, b) =>
        b.pullBytes - a.pullBytes || b.selfBytes - a.selfBytes || a.label.localeCompare(b.label),
    );
    out[route] = rows;
  }

  for (const rows of Object.values(out)) {
    for (const row of rows) {
      const routes =
        pullRouteUsage.get(row.path)?.size ?? pathRouteUsage.get(row.path)?.size ?? 0;
      row.routeCount = routes;
      if (row.badges) row.badges.routes = routes;
    }
  }

  return out;
}
