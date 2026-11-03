import { normalizeModulePath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";

/** Per-route static (sync) import graph with a virtual root (node 0) pointing at the route's seeds. */
export interface RouteGraph {
  route: string;
  firstLoadBytes: number;
  idents: string[];
  succ: number[][];
  preds: number[][];
  /** normalized path per node ("" for the root) */
  paths: string[];
  /** bytes attributed once per normalized path (first node with that path) */
  bytes: number[];
  /** route's measured bytes per normalized path */
  pathBytes: Map<string, number>;
  /** BFS parent for shortest chains (root's parent is 0, unreached = -1) */
  parent: number[];
}

export function collectSeeds(graph: ParsedGraph, route: string): string[] {
  const seeds = new Set<string>();
  const entries = graph.routes.get(route)?.entries;
  if (entries) {
    const bootstraps: string[] = [];
    const refs: string[] = [];
    const routeEntries: string[] = [];
    for (const e of entries) {
      if (e.entry_kind === "client_bootstrap") bootstraps.push(e.module_ident);
      else if (e.entry_kind !== "server" && e.role === "route") routeEntries.push(e.module_ident);
      for (const r of e.client_references ?? []) {
        if (r.reference_kind === "ecmascript") refs.push(r.module_ident);
      }
    }
    const picked = refs.length > 0 || bootstraps.length > 0 ? [...bootstraps, ...refs] : routeEntries;
    for (const id of picked) if (id) seeds.add(id);
  }
  if (seeds.size === 0) {
    const parts = graph.clientPartsByRoute.get(route);
    if (parts) {
      for (const mod of graph.modules.values()) {
        if (parts.has(normalizeModulePath(mod.path))) seeds.add(mod.ident);
      }
    }
  }
  return [...seeds];
}

/** Build the sync-edge graph for a route; null when the route has no measured client bytes. */
export function buildRouteGraph(graph: ParsedGraph, route: string): RouteGraph | null {
  const parts = graph.clientPartsByRoute.get(route);
  if (!parts) return null;
  let firstLoadBytes = 0;
  for (const b of parts.values()) firstLoadBytes += b;

  const idents: string[] = [""];
  const index = new Map<string, number>();
  const succ: number[][] = [[]];
  const intern = (id: string): number => {
    let i = index.get(id);
    if (i === undefined) {
      i = idents.length;
      index.set(id, i);
      idents.push(id);
      succ.push([]);
    }
    return i;
  };

  const queue: number[] = [];
  for (const s of collectSeeds(graph, route)) {
    const had = index.has(s);
    const i = intern(s);
    if (!succ[0].includes(i)) succ[0].push(i);
    if (!had) queue.push(i);
  }
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    const seen = new Set<number>();
    for (const dep of graph.modules.get(idents[u])?.dependencies.sync ?? []) {
      const had = index.has(dep);
      const v = intern(dep);
      if (v === u || seen.has(v)) continue;
      seen.add(v);
      succ[u].push(v);
      if (!had) queue.push(v);
    }
  }
  const n = idents.length;

  const paths = idents.map((id) => (id ? normalizeModulePath(graph.modules.get(id)?.path ?? id) : ""));
  const bytes = new Array<number>(n).fill(0);
  const counted = new Set<string>();
  for (let i = 1; i < n; i++) {
    if (counted.has(paths[i])) continue;
    counted.add(paths[i]);
    bytes[i] = parts.get(paths[i]) ?? 0;
  }

  const preds: number[][] = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) for (const v of succ[u]) preds[v].push(u);

  return { route, firstLoadBytes, idents, succ, preds, paths, bytes, pathBytes: parts, parent: bfsParents(succ, n) };
}

function bfsParents(succ: number[][], n: number, skip?: (u: number, v: number) => boolean): number[] {
  const parent = new Array<number>(n).fill(-1);
  parent[0] = 0;
  const bfs = [0];
  for (let q = 0; q < bfs.length; q++) {
    const u = bfs[q];
    for (const v of succ[u]) {
      if (parent[v] === -1 && !skip?.(u, v)) {
        parent[v] = u;
        bfs.push(v);
      }
    }
  }
  return parent;
}

/** BFS parents with some edges removed (-1 = unreachable without them). */
export function parentsWithout(rg: RouteGraph, skip: (u: number, v: number) => boolean): number[] {
  return bfsParents(rg.succ, rg.idents.length, skip);
}

/** Bytes (deduped by path) that disappear when the nodes unreachable under `parent` are dropped. */
export function lostBytes(rg: RouteGraph, parent: number[]): number {
  const alive = new Set<string>();
  for (let i = 1; i < parent.length; i++) if (parent[i] !== -1) alive.add(rg.paths[i]);
  let lost = 0;
  for (let i = 1; i < parent.length; i++) if (parent[i] === -1 && rg.bytes[i] > 0 && !alive.has(rg.paths[i])) lost += rg.bytes[i];
  return lost;
}

/** Path (module paths, route entry first) following `parent` to node v. */
export function chainFrom(rg: RouteGraph, parent: number[], v: number): string[] {
  const c: string[] = [];
  for (let x = v; x > 0; x = parent[x]) c.push(rg.paths[x]);
  return c.reverse();
}

/** Bytes (deduped by path) reachable from the given nodes. */
export function reachableBytes(rg: RouteGraph, from: Iterable<number>): number {
  const seen = new Set<number>();
  const st = [...from];
  for (const s of st) seen.add(s);
  const paths = new Set<string>();
  while (st.length) {
    const x = st.pop()!;
    paths.add(rg.paths[x]);
    for (const y of rg.succ[x]) if (!seen.has(y)) { seen.add(y); st.push(y); }
  }
  let r = 0;
  for (const p of paths) r += rg.pathBytes.get(p) ?? 0;
  return r;
}
