import {
  isClientJavaScriptOutput,
  isServerJavaScriptOutput,
  normalizeModulePath,
} from "./module-path.js";
import type {
  GraphGroup,
  GraphMeta,
  GraphModule,
  GraphOutput,
  GraphPart,
  GraphRoute,
  ParsedGraph,
} from "./types.js";

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyParsed(): ParsedGraph {
  return {
    meta: null,
    modules: new Map(),
    routes: new Map(),
    clientPartsByRoute: new Map(),
    serverPartsByRoute: new Map(),
    pathRouteUsage: new Map(),
    serverPathRouteUsage: new Map(),
    outputs: [],
    groups: [],
  };
}

function addPartBytes(
  byRoute: Map<string, Map<string, number>>,
  usage: Map<string, Set<string>>,
  route: string,
  path: string,
  bytes: number,
): void {
  let routeMap = byRoute.get(route);
  if (!routeMap) {
    routeMap = new Map();
    byRoute.set(route, routeMap);
  }
  routeMap.set(path, (routeMap.get(path) ?? 0) + bytes);

  let set = usage.get(path);
  if (!set) {
    set = new Set();
    usage.set(path, set);
  }
  set.add(route);
}

function ingestPart(graph: ParsedGraph, part: GraphPart): void {
  if (!part.route) return;
  const filename = part.filename ?? "";
  const path = normalizeModulePath(part.source_path ?? "");
  if (!path) return;

  const bytes =
    numberOrZero(part.compressed_size) > 0
      ? numberOrZero(part.compressed_size)
      : numberOrZero(part.size);

  if (isClientJavaScriptOutput(filename)) {
    addPartBytes(graph.clientPartsByRoute, graph.pathRouteUsage, part.route, path, bytes);
  } else if (isServerJavaScriptOutput(filename)) {
    addPartBytes(graph.serverPartsByRoute, graph.serverPathRouteUsage, part.route, path, bytes);
  }
}

function ensureRoutesFromParts(graph: ParsedGraph): void {
  for (const route of [...graph.clientPartsByRoute.keys(), ...graph.serverPartsByRoute.keys()]) {
    if (!graph.routes.has(route)) {
      graph.routes.set(route, {
        type: "route",
        route,
        entries: null,
        coverage: { entries: "unknown", groups: "unknown" },
      });
    }
  }
}

function ingestRecord(graph: ParsedGraph, record: { type?: string }): void {
  switch (record.type) {
    case "meta":
      graph.meta = record as GraphMeta;
      break;
    case "module": {
      const mod = record as GraphModule;
      if (mod.ident) graph.modules.set(mod.ident, mod);
      break;
    }
    case "route": {
      const route = record as GraphRoute;
      if (route.route) graph.routes.set(route.route, route);
      break;
    }
    case "part":
      ingestPart(graph, record as GraphPart);
      break;
    case "output":
      graph.outputs.push(record as GraphOutput);
      break;
    case "group":
      graph.groups.push(record as GraphGroup);
      break;
    default:
      break;
  }
}

/** Parse a full graph-v1 JSONL string into indexes. */
export function parseGraphV1Jsonl(jsonl: string): ParsedGraph {
  const graph = emptyParsed();
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: { type?: string };
    try {
      record = JSON.parse(trimmed) as { type?: string };
    } catch {
      continue;
    }
    ingestRecord(graph, record);
  }
  ensureRoutesFromParts(graph);
  return graph;
}

/** Streaming-friendly accumulator for line-by-line ingest. */
export function createGraphAccumulator() {
  const graph = emptyParsed();
  return {
    addLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: { type?: string };
      try {
        record = JSON.parse(trimmed) as { type?: string };
      } catch {
        return;
      }
      ingestRecord(graph, record);
    },
    finish(): ParsedGraph {
      ensureRoutesFromParts(graph);
      return graph;
    },
  };
}
