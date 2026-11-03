import { packageNameFromPath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import type { EdgeCut, RouteAttribution } from "./types.js";
import { buildRouteGraph, chainFrom, lostBytes, parentsWithout } from "./reach.js";

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

const DYNAMIC_RUNTIME_RE = /next\/dist\/(?:esm\/)?(?:shared\/lib\/(?:lazy-dynamic|dynamic|loadable)|client\/components\/dynamic)/;
/** Exact re-check (edge removed, path-deduped) is done for the top candidates only. */
const EXACT_CHECK_LIMIT = 200;
const MAX_ALSO_CHAINS = 3;

function attributeRoute(graph: ParsedGraph, route: string, minBytes: number): RouteAttribution {
  const rg = buildRouteGraph(graph, route);
  if (!rg) return { route, firstLoadBytes: 0, measured: false, edges: [] };
  const { succ, preds, paths, bytes, parent } = rg;
  const n = rg.idents.length;
  const result: RouteAttribution = {
    route,
    firstLoadBytes: rg.firstLoadBytes,
    measured: true,
    edges: [],
    hasDynamicRuntime: paths.some((p) => DYNAMIC_RUNTIME_RE.test(p)),
  };

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

  const chainTo = (v: number): string[] => chainFrom(rg, parent, v);

  const dominates = (a: number, b: number): boolean => {
    for (let x = b; ; x = idom[x]) {
      if (x === a) return true;
      if (x === 0) return false;
    }
  };

  const cands: Array<{ cut: EdgeCut; u: number; v: number }> = [];
  for (let u = 1; u < n; u++) {
    if (parent[u] === -1) continue;
    for (const v of succ[u]) {
      // Another entry into v that v doesn't dominate keeps v alive => 0 unique bytes.
      if (!preds[v].every((p) => p === u || dominates(v, p))) continue;
      const uniqueBytes = domBytes[v];
      if (uniqueBytes < minBytes || uniqueBytes <= 0) continue;
      cands.push({
        u,
        v,
        cut: {
          edge: { importer: paths[u], imported: paths[v], packageName: packageNameFromPath(paths[v]) },
          chain: [...chainTo(u), paths[v]],
          uniqueBytes,
          subtreeBytes: subtreeBytes(v),
        },
      });
    }
  }
  // Exact re-check for the top candidates: remove only this edge and recompute reachability by path.
  // Catches the same file reached under another module ident (dominators work on idents) and records
  // the other static chains that keep it alive. An edge that turns out to save nothing stays, at 0 bytes.
  cands.sort((a, b) => b.cut.uniqueBytes - a.cut.uniqueBytes);
  cands.slice(0, EXACT_CHECK_LIMIT).forEach(({ cut, u, v }) => {
    const without = parentsWithout(rg, (a, b) => a === u && b === v);
    const exact = lostBytes(rg, without);
    const also: string[][] = [];
    for (let i = 1; i < n && also.length < MAX_ALSO_CHAINS; i++) {
      if (paths[i] !== paths[v] || without[i] === -1) continue;
      for (const p of preds[i]) {
        if (p === 0 || (p === u && i === v) || without[p] === -1) continue;
        also.push([...chainFrom(rg, without, p), paths[i]]);
        if (also.length >= MAX_ALSO_CHAINS) break;
      }
    }
    if (also.length) cut.alsoReachableVia = also;
    if (exact < cut.uniqueBytes) cut.uniqueBytes = exact;
  });
  const edges = cands.map((c) => c.cut).filter((c) => c.uniqueBytes >= minBytes || c.alsoReachableVia);
  edges.sort((a, b) => b.uniqueBytes - a.uniqueBytes || a.edge.imported.localeCompare(b.edge.imported));
  result.edges = edges;
  return result;
}
