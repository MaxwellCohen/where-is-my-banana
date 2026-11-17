import { existsSync, realpathSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { isAppSourcePath, normalizeModulePath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";

const SAMPLE = 200;

function realRoot(projectRoot: string): string {
  const root = resolve(projectRoot);
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Turbopack reports module paths from its own root, which in a monorepo is the workspace root, not the project.
 * Returns the project's path below that root ("packages/web"), or null when paths are already project-relative.
 * Decided on disk: the prefix is real when files exist with it stripped but not with it kept. When more than one
 * suffix of the project path passes (a sibling folder named like the project), the one more files agree on wins.
 */
export function rootPrefix(paths: Iterable<string>, projectRoot: string): string | null {
  const root = realRoot(projectRoot);
  const segs = root.split(/[\\/]/).filter(Boolean);
  const app = [...new Set(paths)].filter((p) => isAppSourcePath(p) && !p.startsWith("../"));
  let best: string | null = null;
  let bestScore = 0;
  for (let k = 1; k <= segs.length; k++) {
    const prefix = `${segs.slice(-k).join("/")}/`;
    const under = app.filter((p) => p.startsWith(prefix)).slice(0, SAMPLE);
    if (under.length === 0) continue;
    const stripped = under.filter((p) => existsSync(join(root, p.slice(prefix.length)))).length;
    const kept = under.filter((p) => existsSync(join(root, p))).length;
    if (stripped - kept > bestScore) {
      bestScore = stripped - kept;
      best = prefix.slice(0, -1);
    }
  }
  return best;
}

/** Path rewriter for a graph rooted `prefix` above the project: project files lose the prefix, other real files become `../` paths. */
export function rebaser(projectRoot: string, prefix: string): (path: string) => string {
  const root = realRoot(projectRoot);
  const up = "../".repeat(prefix.split("/").length);
  const cache = new Map<string, string>();
  return (path) => {
    let out = cache.get(path);
    if (out === undefined) {
      if (path.startsWith(`${prefix}/`)) out = path.slice(prefix.length + 1);
      else if (!path || path.startsWith("[") || path.startsWith("../") || !existsSync(join(root, up, path))) out = path;
      else out = posix.relative(prefix, path);
      cache.set(path, out);
    }
    return out;
  };
}

/** Make every path in the graph relative to the project root (in place). No-op outside a monorepo. */
export function rebaseGraph(graph: ParsedGraph, projectRoot: string): ParsedGraph {
  const modulePaths = [...graph.modules.values()].map((m) => normalizeModulePath(m.path));
  const prefix = rootPrefix(modulePaths, projectRoot);
  if (!prefix) return graph;
  const re = rebaser(projectRoot, prefix);
  for (const m of graph.modules.values()) m.path = re(normalizeModulePath(m.path));
  for (const r of graph.routes.values()) {
    for (const e of r.entries ?? []) {
      if (e.module_path) e.module_path = re(normalizeModulePath(e.module_path));
      for (const c of e.client_references ?? []) if (c.module_path) c.module_path = re(normalizeModulePath(c.module_path));
    }
  }
  const rekey = <V>(m: Map<string, V>): Map<string, V> => new Map([...m].map(([k, v]) => [re(k), v]));
  for (const side of [graph.clientPartsByRoute, graph.serverPartsByRoute]) for (const [route, parts] of side) side.set(route, rekey(parts));
  graph.pathRouteUsage = rekey(graph.pathRouteUsage);
  graph.serverPathRouteUsage = rekey(graph.serverPathRouteUsage);
  return graph;
}
