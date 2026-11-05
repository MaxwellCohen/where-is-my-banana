import { normalizeModulePath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";

/** Per-route static (sync) import graph with a virtual root (node 0) pointing at the route's seeds. */
export interface DynamicRef {
  /** node index of the (statically reachable) importer */
  from: number;
  importer: string;
  imported: string;
  /** bytes of the dynamic chunk closure first claimed by this edge (not in the static closure) */
  bytes: number;
  /** the target is ALSO in the static closure, so this dynamic import() buys nothing */
  alsoStatic: boolean;
}

export interface RouteGraph {
  route: string;
  /** compressed bytes of the static closure's client JS (dynamic-only chunks excluded) */
  firstLoadBytes: number;
  /** async (import()/next/dynamic/React.lazy) edges leaving statically reachable modules */
  dynamicRefs: DynamicRef[];
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
  /** node is reachable from an injected entry (instrumentation-client etc.) */
  fromInjected: boolean[];
}

/** Files Next injects into every page's client entry. */
export const INJECTED_CLIENT_ENTRY_FILES = ["instrumentation-client.ts", "instrumentation-client.tsx", "instrumentation-client.js", "src/instrumentation-client.ts", "src/instrumentation-client.tsx", "src/instrumentation-client.js"];
const INJECTED_ALWAYS_RE = /^(?:\[project\]\/)?(?:src\/)?instrumentation-client\.[cm]?[jt]sx?$/;
/** Server/edge entries: only seeded when they actually contribute client bytes to the route. */
const INJECTED_IF_CLIENT_RE = /^(?:\[project\]\/)?(?:src\/)?(?:instrumentation|middleware|proxy)\.[cm]?[jt]sx?$/;

const injectedCache = new WeakMap<ParsedGraph, { always: string[]; ifClient: Array<{ ident: string; path: string }> }>();

/** Injected entries (instrumentation-client always; instrumentation/middleware/proxy only if client-bundled in `route`). */
export function injectedEntries(graph: ParsedGraph, route: string): string[] {
  let c = injectedCache.get(graph);
  if (!c) {
    c = { always: [], ifClient: [] };
    for (const m of graph.modules.values()) {
      const p = normalizeModulePath(m.path);
      if (INJECTED_ALWAYS_RE.test(p)) c.always.push(m.ident);
      else if (INJECTED_IF_CLIENT_RE.test(p)) c.ifClient.push({ ident: m.ident, path: p });
    }
    injectedCache.set(graph, c);
  }
  const parts = graph.clientPartsByRoute.get(route);
  return [...c.always, ...c.ifClient.filter((m) => parts?.has(m.path)).map((m) => m.ident)];
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
  for (const id of injectedEntries(graph, route)) seeds.add(id);
  return [...seeds];
}

/** Build the sync-edge graph for a route; null when the route has no measured client bytes. */
export function buildRouteGraph(graph: ParsedGraph, route: string): RouteGraph | null {
  const parts = graph.clientPartsByRoute.get(route);
  if (!parts) return null;
  let totalBytes = 0;
  for (const b of parts.values()) totalBytes += b;

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

  const injectedIdents = new Set(injectedEntries(graph, route));
  const queue: number[] = [];
  const seedSet = new Set<number>();
  for (const s of collectSeeds(graph, route)) {
    const had = index.has(s);
    const i = intern(s);
    if (!seedSet.has(i)) { seedSet.add(i); succ[0].push(i); }
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

  // Dynamic accounting: async edges out of the static closure. Chunks reachable only through them are
  // not first-load JS (they are preloaded or on demand), so they are subtracted from the route total.
  const staticPaths = new Set(paths.slice(1));
  const claimed = new Set<string>();
  const dynamicRefs: DynamicRef[] = [];
  let dynamicBytes = 0;
  for (let u = 1; u < n; u++) {
    for (const dep of graph.modules.get(idents[u])?.dependencies.async ?? []) {
      const dm = graph.modules.get(dep);
      if (!dm) continue;
      const dpath = normalizeModulePath(dm.path);
      if (!dpath || dpath === paths[u]) continue;
      if (staticPaths.has(dpath)) {
        dynamicRefs.push({ from: u, importer: paths[u], imported: dpath, bytes: 0, alsoStatic: true });
        continue;
      }
      let bytes = 0;
      const seen = new Set<string>([dep]);
      const st = [dep];
      while (st.length) {
        const m = graph.modules.get(st.pop()!);
        if (!m) continue;
        const mp = normalizeModulePath(m.path);
        if (!staticPaths.has(mp) && !claimed.has(mp)) {
          claimed.add(mp);
          bytes += parts.get(mp) ?? 0;
        }
        for (const d of m.dependencies.sync) if (!seen.has(d)) { seen.add(d); st.push(d); }
      }
      dynamicBytes += bytes;
      dynamicRefs.push({ from: u, importer: paths[u], imported: dpath, bytes, alsoStatic: false });
    }
  }
  const firstLoadBytes = totalBytes - dynamicBytes;

  const fromInjected = new Array<boolean>(n).fill(false);
  const st: number[] = [];
  for (const id of injectedIdents) {
    const i = index.get(id);
    if (i !== undefined && !fromInjected[i]) { fromInjected[i] = true; st.push(i); }
  }
  while (st.length) for (const v of succ[st.pop()!]) if (!fromInjected[v]) { fromInjected[v] = true; st.push(v); }

  return { route, firstLoadBytes, dynamicRefs, idents, succ, preds, paths, bytes, pathBytes: parts, parent: bfsParents(succ, n), fromInjected };
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
