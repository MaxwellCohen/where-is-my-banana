import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageNameFromPath } from "@wimb/graph-v1";
import { analyzeDynamicUsage } from "./usage-analyze.js";
import type { RouteGraph } from "./reach.js";
import type { DynamicEdgeInfo } from "./types.js";

export interface LazyAccounting {
  firstLoadBytes: number;
  /** dynamic chunks Next still preloads: server-rendered importer, unconditional use (or unknown) */
  preloadedBytes: number;
  /** dynamic chunks fetched only when needed */
  onDemandBytes: number;
  edges: DynamicEdgeInfo[];
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Split a route's dynamic (import()/next/dynamic/React.lazy) chunks into preloaded vs on-demand.
 * Model: Next emits preload tags for dynamic chunks of components rendered on the server, so a dynamic edge
 * whose component renders unconditionally (or whose usage is unknown) is "preloaded"; conditional,
 * handler-only, bare import() and ssr:false edges are "on-demand". Library-internal import()s count as on-demand.
 */
export async function accountLazy(rg: RouteGraph, projectRoot: string): Promise<LazyAccounting> {
  const out: LazyAccounting = { firstLoadBytes: rg.firstLoadBytes, preloadedBytes: 0, onDemandBytes: 0, edges: [] };
  const cache = new Map<string, string | null>();
  for (const ref of rg.dynamicRefs) {
    if (ref.alsoStatic || ref.bytes <= 0) continue;
    let kind: DynamicEdgeInfo["kind"] = "on-demand";
    let reason: string;
    if (ref.importer.includes("node_modules/")) {
      reason = "library-internal import()";
    } else {
      let src = cache.get(ref.importer);
      if (src === undefined) {
        src = await readText(join(projectRoot, ref.importer));
        cache.set(ref.importer, src);
      }
      const u = src ? analyzeDynamicUsage(ref.importer, src, { importer: ref.importer, imported: ref.imported, packageName: packageNameFromPath(ref.imported) }) : null;
      if (!u?.found) {
        kind = "preloaded";
        reason = "usage unknown; assumed server-rendered and unconditional";
      } else if (u.ssrFalse) reason = "ssr:false: not rendered on the server";
      else if (!u.wrapped) reason = "bare import(): runs when called";
      else if (u.usage === "always-rendered" || u.usage === "unknown") {
        kind = "preloaded";
        reason = `${u.usage === "unknown" ? "usage unknown" : "rendered unconditionally"}: Next preloads the chunk on server render`;
      } else reason = u.usage === "conditional-render" ? "rendered conditionally" : "only used in handlers";
    }
    if (kind === "preloaded") out.preloadedBytes += ref.bytes;
    else out.onDemandBytes += ref.bytes;
    out.edges.push({ importer: ref.importer, imported: ref.imported, bytes: ref.bytes, kind, reason });
  }
  out.edges.sort((a, b) => b.bytes - a.bytes);
  return out;
}
