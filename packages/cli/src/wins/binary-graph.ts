import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeModulePath } from "@wimb/graph-v1";
import type { GraphModule, GraphRoute, ParsedGraph } from "@wimb/graph-v1";
import { discoverRouteAnalyzeFiles } from "../build/analyze.js";
import {
  parseDataFile,
  readEdgesAtIndex,
  buildFullPaths,
  type AnalyzeRouteHeader,
  type ModulesHeader,
} from "../build/binary-format.js";
import { buildGraph, relPath } from "../graph/builder.js";

export interface BinaryGraphResult {
  graph: ParsedGraph;
  /** Where import edges came from. Bytes always come from the artifacts. */
  edgeSource: "modules.data" | "source-graph";
}

function routeClientBytes(filePath: string): Map<string, number> {
  const out = new Map<string, number>();
  const { header, binary } = parseDataFile<AnalyzeRouteHeader>(readFileSync(filePath));
  const sources = header.sources ?? [];
  const parts = header.chunk_parts ?? [];
  const files = header.output_files ?? [];
  const full = buildFullPaths(sources);
  let anyClient = false;
  const per = sources.map((_, i) => {
    let comp = 0;
    let size = 0;
    for (const idx of readEdgesAtIndex(binary, header.source_chunk_parts, i)) {
      const cp = parts[idx];
      const f = files[cp?.output_file_index ?? -1]?.filename ?? "";
      if (!cp || !f.endsWith(".js") || !f.startsWith("[client-fs]/")) continue;
      anyClient = true;
      comp += cp.compressed_size;
      size += cp.size;
    }
    return comp > 0 ? comp : size;
  });
  if (!anyClient) return out;
  for (let i = 0; i < sources.length; i++) {
    const p = normalizeModulePath(full[i] ?? "");
    if (p && per[i] > 0) out.set(p, (out.get(p) ?? 0) + per[i]);
  }
  return out;
}

function newModule(ident: string, path: string): GraphModule {
  return { type: "module", ident, path, dependencies: { sync: [], async: [], traced: [] } };
}

/** Convert pre-16.4 `.next/diagnostics/analyze/data` binary artifacts into a graph-v1-shaped ParsedGraph. */
export async function buildGraphFromBinary(
  dataDir: string,
  projectRoot: string,
): Promise<BinaryGraphResult | null> {
  const routeFiles = discoverRouteAnalyzeFiles(dataDir);
  const perRoute = new Map<string, Map<string, number>>();
  for (const { route, filePath } of routeFiles) {
    try {
      const bytes = routeClientBytes(filePath);
      if (bytes.size > 0) perRoute.set(route, bytes);
    } catch {
      // skip malformed route
    }
  }
  if (perRoute.size === 0) return null;

  const modules = new Map<string, GraphModule>();
  const byPath = new Map<string, string>(); // normalized path -> ident (first)
  let edgeSource: BinaryGraphResult["edgeSource"] = "source-graph";

  const modulesPath = join(dataDir, "modules.data");
  if (existsSync(modulesPath)) {
    try {
      const { header, binary } = parseDataFile<ModulesHeader>(readFileSync(modulesPath));
      const list = header.modules ?? [];
      const hasEdges = !!header.module_dependencies || !!header.async_module_dependencies;
      if (hasEdges) edgeSource = "modules.data";
      const idents = list.map((m, i) => `${i}:${m.ident ?? m.path ?? ""}`);
      list.forEach((m, i) => {
        const path = normalizeModulePath(m.path ?? m.ident ?? "");
        if (!path) return;
        modules.set(idents[i], newModule(idents[i], path));
        if (!byPath.has(path)) byPath.set(path, idents[i]);
      });
      if (hasEdges) {
        list.forEach((_, i) => {
          const mod = modules.get(idents[i]);
          if (!mod) return;
          for (const d of readEdgesAtIndex(binary, header.module_dependencies, i)) {
            if (idents[d] && modules.has(idents[d])) mod.dependencies.sync.push(idents[d]);
          }
          for (const d of readEdgesAtIndex(binary, header.async_module_dependencies, i)) {
            if (idents[d] && modules.has(idents[d])) mod.dependencies.async.push(idents[d]);
          }
        });
      }
    } catch {
      // fall through to source graph
    }
  }

  const ensure = (path: string): GraphModule => {
    const id = byPath.get(path);
    if (id) return modules.get(id)!;
    const m = newModule(path, path);
    modules.set(path, m);
    byPath.set(path, path);
    return m;
  };
  for (const bytes of perRoute.values()) for (const p of bytes.keys()) ensure(p);

  if (edgeSource === "source-graph") {
    const sg = await buildGraph(projectRoot);
    for (const [file, mod] of sg.modules) {
      const from = normalizeModulePath(relPath(projectRoot, file));
      const importer = byPath.get(from);
      if (!importer) continue;
      const deps = modules.get(importer)!.dependencies;
      for (const imp of mod.imports) {
        if (!imp.resolvedPath || imp.isTypeOnly) continue;
        const to = byPath.get(normalizeModulePath(relPath(projectRoot, imp.resolvedPath)));
        if (!to || to === importer) continue;
        (imp.isDynamic ? deps.async : deps.sync).push(to);
      }
    }
  }

  const routes = new Map<string, GraphRoute>();
  const clientPartsByRoute = new Map<string, Map<string, number>>();
  const pathRouteUsage = new Map<string, Set<string>>();
  for (const [route, bytes] of perRoute) {
    clientPartsByRoute.set(route, bytes);
    for (const p of bytes.keys()) {
      let s = pathRouteUsage.get(p);
      if (!s) pathRouteUsage.set(p, (s = new Set()));
      s.add(route);
    }
    // Seeds: measured modules with no sync importer among measured modules; then any left unreached (cycles).
    const inRoute = [...modules.values()].filter((m) => bytes.has(normalizeModulePath(m.path)));
    const ids = new Set(inRoute.map((m) => m.ident));
    const hasImporter = new Set<string>();
    for (const m of inRoute) for (const d of m.dependencies.sync) if (d !== m.ident && ids.has(d)) hasImporter.add(d);
    const seeds = inRoute.filter((m) => !hasImporter.has(m.ident)).map((m) => m.ident);
    const reached = new Set<string>();
    const walk = (from: string[]) => {
      const q = [...from];
      while (q.length) {
        const id = q.pop()!;
        if (reached.has(id)) continue;
        reached.add(id);
        for (const d of modules.get(id)?.dependencies.sync ?? []) q.push(d);
      }
    };
    walk(seeds);
    for (const m of inRoute) {
      if (!reached.has(m.ident)) {
        seeds.push(m.ident);
        walk([m.ident]);
      }
    }
    routes.set(route, {
      type: "route",
      route,
      entries: [
        {
          route_entry_id: `${route}#client`,
          module_ident: seeds[0] ?? "",
          module_path: modules.get(seeds[0] ?? "")?.path ?? "",
          role: "route",
          entry_kind: "client_bootstrap",
          client_references: seeds.map((id) => ({
            module_ident: id,
            module_path: modules.get(id)?.path ?? "",
            reference_kind: "ecmascript" as const,
          })),
        },
      ],
      coverage: { entries: "exact", groups: "unknown" },
    });
  }

  const graph: ParsedGraph = {
    meta: null,
    modules,
    routes,
    clientPartsByRoute,
    serverPartsByRoute: new Map(),
    pathRouteUsage,
    serverPathRouteUsage: new Map(),
    outputs: [],
    groups: [],
  };
  return { graph, edgeSource };
}
