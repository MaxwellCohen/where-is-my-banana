import { packageNameFromPath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import { buildRouteGraph, chainFrom, lostBytes, parentsWithout, reachableBytes, type RouteGraph } from "../wins/reach.js";

export interface WhyCut {
  importer: string;
  imported: string;
  /** bytes leaving this route if only this edge is cut */
  savedBytes: number;
  /** another chain that keeps the target in the route after the cut (null = cut removes it) */
  stillReachableVia: string[] | null;
}

export interface WhyChain {
  chain: string[];
  cut: WhyCut | null;
}

export interface WhyRoute {
  route: string;
  firstLoadBytes: number;
  /** bytes behind the target (everything it pulls in) */
  subtreeBytes: number;
  /** bytes that leave the route if every static edge into the target is removed */
  uniqueBytes: number;
  chains: WhyChain[];
}

export interface WhyReport {
  target: string;
  /** distinct packages / files the target matched in the client graph */
  matches: string[];
  routes: WhyRoute[];
  /** why nothing was found, when routes is empty */
  /** routes that also contain the target but were not listed (no --all-routes / --route) */
  hiddenRoutes?: number;
  notFound?: "server-only" | "lazy-only" | "absent";
  message?: string;
}

export interface WhyOptions {
  route?: string;
  allRoutes?: boolean;
  chains?: number;
}

const globToRe = (g: string) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);

/** Package name for node_modules paths, else the file path itself. */
const keyOf = (path: string) => packageNameFromPath(path) ?? path;

function matcherFor(target: string, keys: Set<string>): { matched: string[]; ambiguous: boolean } {
  const t = target.replace(/^\.\//, "");
  if (t.includes("*")) {
    const re = globToRe(t);
    return { matched: [...keys].filter((k) => re.test(k) || re.test(k.split("/").pop() ?? "")), ambiguous: false };
  }
  const exact = [...keys].filter((k) => k === t);
  if (exact.length) return { matched: exact, ambiguous: false };
  const suffix = [...keys].filter((k) => k.endsWith(`/${t}`) || k.replace(/\.[cm]?[jt]sx?$/, "") === t);
  if (suffix.length) return { matched: suffix, ambiguous: suffix.length > 1 };
  const sub = [...keys].filter((k) => k.includes(t));
  return { matched: sub, ambiguous: sub.length > 1 };
}

function clientKeys(graph: ParsedGraph): Set<string> {
  const keys = new Set<string>();
  for (const parts of graph.clientPartsByRoute.values()) for (const p of parts.keys()) keys.add(keyOf(p));
  return keys;
}

function otherSideNote(graph: ParsedGraph, target: string): WhyReport["notFound"] {
  const t = target.replace(/\*/g, "");
  const inServer = [...graph.serverPartsByRoute.values()].some((m) => [...m.keys()].some((p) => keyOf(p).includes(t)));
  if (inServer) return "server-only";
  const inGraph = [...graph.modules.values()].some((m) => keyOf(m.path).includes(t));
  return inGraph ? "lazy-only" : "absent";
}

function analyzeRoute(rg: RouteGraph, matchedKeys: Set<string>, maxChains: number): WhyRoute | null {
  const n = rg.idents.length;
  const targets = new Set<number>();
  for (let i = 1; i < n; i++) if (matchedKeys.has(keyOf(rg.paths[i]))) targets.add(i);
  if (targets.size === 0) return null;
  const isEdgeIntoTarget = (u: number, v: number) => targets.has(v) && !targets.has(u);
  const uniqueBytes = lostBytes(rg, parentsWithout(rg, isEdgeIntoTarget));

  // Nodes that can reach a target (reverse BFS) bound the alternative-chain search.
  const canReach = new Uint8Array(n);
  const rq = [...targets];
  for (const t of rq) canReach[t] = 1;
  for (let q = 0; q < rq.length; q++) for (const p of rg.preds[rq[q]]) if (!canReach[p]) { canReach[p] = 1; rq.push(p); }

  const shortestFrom = (start: number): number[] | null => {
    const par = new Map<number, number>([[start, -1]]);
    const bfs = [start];
    for (let q = 0; q < bfs.length; q++) {
      const u = bfs[q];
      if (targets.has(u)) {
        const path: number[] = [];
        for (let x = u; x !== -1; x = par.get(x)!) path.push(x);
        return path.reverse();
      }
      for (const v of rg.succ[u]) if (canReach[v] && !par.has(v)) { par.set(v, u); bfs.push(v); }
    }
    return null;
  };

  // One chain per distinct first hop (seed + its next module), shortest first.
  const found = new Map<string, number[]>();
  for (const seed of rg.succ[0]) {
    if (!canReach[seed]) continue;
    const hops = targets.has(seed) ? [seed] : rg.succ[seed].filter((h) => canReach[h]);
    for (const h of hops) {
      const path = shortestFrom(h);
      if (!path) continue;
      const full = targets.has(seed) ? path : [seed, ...path];
      const key = `${seed}>${full[1] ?? ""}`;
      if (!found.has(key) || found.get(key)!.length > full.length) found.set(key, full);
    }
  }
  const ranked = [...found.values()].sort((a, b) => a.length - b.length).slice(0, maxChains);

  const chains: WhyChain[] = ranked.map((nodes) => {
    // The cut an engineer can make: the last edge into the target on this chain (app-owned importer preferred).
    let k = nodes.length - 1;
    for (let i = nodes.length - 1; i > 0; i--) {
      if (keyOf(rg.paths[nodes[i - 1]]) === rg.paths[nodes[i - 1]] && !targets.has(nodes[i - 1])) { k = i; break; }
    }
    const cut: WhyCut | null = k > 0 ? cutFor(rg, nodes[k - 1], nodes[k], targets) : null;
    return { chain: nodes.map((i) => rg.paths[i]), cut };
  });

  return {
    route: rg.route,
    firstLoadBytes: rg.firstLoadBytes,
    subtreeBytes: reachableBytes(rg, targets),
    uniqueBytes,
    chains,
  };
}

function cutFor(rg: RouteGraph, u: number, v: number, targets: Set<number>): WhyCut {
  const without = parentsWithout(rg, (a, b) => a === u && b === v);
  const saved = lostBytes(rg, without);
  let still: string[] | null = null;
  for (const t of targets) {
    if (without[t] !== -1) { still = chainFrom(rg, without, t); break; }
  }
  return { importer: rg.paths[u], imported: rg.paths[v], savedBytes: saved, stillReachableVia: still };
}

export function whyReport(graph: ParsedGraph, target: string, opts: WhyOptions = {}): WhyReport {
  const maxChains = Math.max(1, opts.chains ?? 3);
  const keys = clientKeys(graph);
  const { matched, ambiguous } = matcherFor(target, keys);
  if (matched.length === 0) {
    const notFound = otherSideNote(graph, target);
    const message =
      notFound === "server-only"
        ? `'${target}' is only in the server bundle, not in client first-load JS.`
        : notFound === "lazy-only"
          ? `'${target}' is not in any route's first-load JS; it is only reachable through dynamic import() (already lazy).`
          : `'${target}' is not in the client graph. Try a package name (e.g. 'moment', '@scope/pkg'), a path fragment, or a glob.`;
    return { target, matches: [], routes: [], notFound, message };
  }
  if (ambiguous && !target.includes("*")) {
    return { target, matches: matched.sort(), routes: [], message: `'${target}' matches ${matched.length} modules; use an exact name or a glob (e.g. '${target}*'):` };
  }
  const matchedKeys = new Set(matched);
  let routes: WhyRoute[] = [];
  for (const route of [...graph.routes.keys()].sort()) {
    if (opts.route && !route.includes(opts.route)) continue;
    const rg = buildRouteGraph(graph, route);
    const r = rg && analyzeRoute(rg, matchedKeys, maxChains);
    if (r) routes.push(r);
  }
  if (routes.length === 0) {
    return { target, matches: matched.sort(), routes, notFound: "lazy-only", message: `'${target}' is in the client graph but not in first-load JS of ${opts.route ? `routes matching '${opts.route}'` : "any route"}.` };
  }
  routes.sort((a, b) => b.uniqueBytes - a.uniqueBytes || a.route.localeCompare(b.route));
  const hidden = !opts.allRoutes && !opts.route ? routes.length - 1 : 0;
  if (hidden > 0) routes = routes.slice(0, 1);
  return { target, matches: matched.sort(), routes, ...(hidden > 0 ? { hiddenRoutes: hidden } : {}) };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

export function formatWhy(report: WhyReport): string {
  const out: string[] = [];
  if (report.message) out.push(report.message);
  if (report.routes.length === 0) {
    if (report.matches.length > 1) out.push(...report.matches.slice(0, 30).map((m) => `  ${m}`));
    return out.join("\n");
  }
  out.push(`${report.matches.length > 1 ? `${report.target} (${report.matches.join(", ")})` : report.matches[0]} is in the client first-load bundle:`);
  for (const r of report.routes) {
    out.push("", `Route ${r.route}  (first load ${kb(r.firstLoadBytes)}): target pulls in ${kb(r.subtreeBytes)}, ${kb(r.uniqueBytes)} unique`);
    r.chains.forEach((c, i) => {
      out.push(`  ${i === 0 ? "shortest" : `also #${i + 1}`}: ${c.chain.join(" -> ")}`);
      if (c.cut) {
        const x = c.cut;
        out.push(
          x.stillReachableVia
            ? `    cut ${x.importer} -> ${x.imported} here saves ${kb(x.savedBytes)}: still reachable via ${x.stillReachableVia.join(" -> ")}`
            : `    cut ${x.importer} -> ${x.imported} here removes it and saves ${kb(x.savedBytes)}`,
        );
      }
    });
  }
  if (report.hiddenRoutes) out.push("", `(+${report.hiddenRoutes} more route${report.hiddenRoutes === 1 ? "" : "s"} include it; use --all-routes or --route <substr>)`);
  return out.join("\n");
}
