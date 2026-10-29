import { normalizeModulePath, packageNameFromPath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import type { EdgeCut, RouteAttribution } from "./types.js";

export interface AttributeOptions {
  /** Drop edges whose uniqueBytes is below this (default 2048). */
  minBytes?: number;
}

const DEFAULT_MIN_BYTES = 2048;

/**
 * uniqueBytes semantics (exact: bytes lost from the route if ONLY edge u->v is deleted):
 *  - If v has another incoming sync edge p->v (or v is a route seed) where p is NOT dominated
 *    by v, v stays reachable avoiding u->v => 0.
 *  - Otherwise every other entry into v comes from inside v's own dominated region (e.g. a
 *    back-edge in a cycle), so u->v is v's only real entry; modules dominated by v (v's
 *    subtree in the dominator tree) all disappear => their attributed bytes.
 * Dominators: Cooper-Harvey-Kennedy iterative algorithm over a virtual root -> seeds.
 * Bytes are attributed once per normalized path (first module ident seen with that path).
 */
export function attributeRoutes(graph: ParsedGraph, opts: AttributeOptions = {}): RouteAttribution[] {
  const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
  const out: RouteAttribution[] = [];
  for (const route of [...graph.routes.keys()].sort()) {
    out.push(attributeRoute(graph, route, minBytes));
  }
  return out;
}

function collectSeeds(graph: ParsedGraph, route: string): string[] {
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

function attributeRoute(graph: ParsedGraph, route: string, minBytes: number): RouteAttribution {
  const parts = graph.clientPartsByRoute.get(route);
  let firstLoadBytes = 0;
  if (parts) for (const b of parts.values()) firstLoadBytes += b;
  const result: RouteAttribution = { route, firstLoadBytes, measured: !!parts, edges: [] };
  if (!parts) return result;

  // Node 0 = virtual root; others = module idents reachable via sync edges.
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

  // BFS parents for shortest chains.
  const parent = new Array<number>(n).fill(-1);
  parent[0] = 0;
  const bfs = [0];
  for (let q = 0; q < bfs.length; q++) {
    for (const v of succ[bfs[q]]) {
      if (parent[v] === -1) {
        parent[v] = bfs[q];
        bfs.push(v);
      }
    }
  }

  // Iterative DFS postorder, then Cooper-Harvey-Kennedy dominators.
  const post = new Array<number>(n).fill(-1);
  const order: number[] = [];
  const visited = new Array<boolean>(n).fill(false);
  const stack: Array<[number, number]> = [[0, 0]];
  visited[0] = true;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const s = succ[top[0]];
    if (top[1] < s.length) {
      const v = s[top[1]++];
      if (!visited[v]) {
        visited[v] = true;
        stack.push([v, 0]);
      }
    } else {
      post[top[0]] = order.length;
      order.push(top[0]);
      stack.pop();
    }
  }
  const idom = new Array<number>(n).fill(-1);
  idom[0] = 0;
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (post[a] < post[b]) a = idom[a];
      while (post[b] < post[a]) b = idom[b];
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = order.length - 2; k >= 0; k--) {
      const b = order[k];
      let nd = -1;
      for (const p of preds[b]) {
        if (idom[p] === -1) continue;
        nd = nd === -1 ? p : intersect(p, nd);
      }
      if (nd !== idom[b]) {
        idom[b] = nd;
        changed = true;
      }
    }
  }
  // Dominated-subtree bytes: fold in postorder (children of the dom tree finish before idom).
  const domBytes = bytes.slice();
  for (const v of order) if (v !== 0) domBytes[idom[v]] += domBytes[v];

  const reach = new Map<number, number>();
  const subtreeBytes = (v: number): number => {
    let r = reach.get(v);
    if (r !== undefined) return r;
    const seen = new Set<number>([v]);
    const st = [v];
    r = 0;
    while (st.length) {
      const x = st.pop()!;
      r += bytes[x];
      for (const y of succ[x]) if (!seen.has(y)) { seen.add(y); st.push(y); }
    }
    reach.set(v, r);
    return r;
  };

  const chainTo = (v: number): string[] => {
    const c: string[] = [];
    for (let x = v; x !== 0; x = parent[x]) c.push(paths[x]);
    return c.reverse();
  };

  const dominates = (a: number, b: number): boolean => {
    for (let x = b; ; x = idom[x]) {
      if (x === a) return true;
      if (x === 0) return false;
    }
  };

  const edges: EdgeCut[] = [];
  for (let u = 1; u < n; u++) {
    if (parent[u] === -1) continue;
    for (const v of succ[u]) {
      // Another entry into v that v doesn't dominate keeps v alive => 0 unique bytes.
      if (!preds[v].every((p) => p === u || dominates(v, p))) continue;
      const uniqueBytes = domBytes[v];
      if (uniqueBytes < minBytes || uniqueBytes <= 0) continue;
      edges.push({
        edge: { importer: paths[u], imported: paths[v], packageName: packageNameFromPath(paths[v]) },
        chain: [...chainTo(u), paths[v]],
        uniqueBytes,
        subtreeBytes: subtreeBytes(v),
      });
    }
  }
  edges.sort((a, b) => b.uniqueBytes - a.uniqueBytes || a.edge.imported.localeCompare(b.edge.imported));
  result.edges = edges;
  return result;
}
