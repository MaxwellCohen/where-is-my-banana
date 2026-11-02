import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, relative, isAbsolute } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { normalizeModulePath } from "@wimb/graph-v1";
import type { GraphModule, GraphRoute, ParsedGraph } from "@wimb/graph-v1";

interface ViteChunk {
  type: "chunk";
  code: string;
  name: string;
  facadeModuleId: string | null;
  isEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  fileName: string;
  modules: Record<string, { renderedLength: number }>;
}

interface ViteModuleInfo {
  importedIds: readonly string[];
  dynamicallyImportedIds: readonly string[];
}

interface ViteBundleItem {
  type: string;
}

interface ViteApi {
  build(config: Record<string, unknown>): Promise<unknown>;
}

/** Route path for an entry chunk, derived from its facade module (project-relative) so same-named entries don't collide. */
export function routeForEntry(facadeRel: string, fallbackName: string): string {
  if (!facadeRel) return `/${fallbackName}`;
  const noExt = facadeRel.replace(/\.[^./]+$/, "");
  const isHtml = /\.html?$/.test(facadeRel);
  const trimmed = isHtml ? noExt.replace(/(^|\/)index$/, "") : noExt;
  return `/${trimmed}`;
}

function tanstackSplitId(c: ViteChunk): string | null {
  if (c.facadeModuleId?.includes("?tsr-split=")) return c.facadeModuleId;
  return Object.keys(c.modules).find((id) => id.includes("?tsr-split=")) ?? null;
}

/** Project-relative TanStack Router route file -> URL pattern, or null for layouts/root/ignored files. */
export function routeForTanstackFile(rel: string): string | null {
  const noExt = rel.split("?")[0].replace(/\.[^./]+$/, "");
  const idx = noExt.lastIndexOf("routes/");
  const within = idx >= 0 ? noExt.slice(idx + "routes/".length) : noExt;
  const parts = within.split("/").flatMap((p) => (p.startsWith("-") ? [p] : p.split(".")));
  if (parts.some((p) => p.startsWith("-") || p === "__root")) return null;
  const last = parts[parts.length - 1];
  if (last === "route" || (last.startsWith("_") && !last.startsWith("__"))) return null;
  const segs: string[] = [];
  for (const raw of parts) {
    if (raw === "index" || /^\(.*\)$/.test(raw) || raw.startsWith("_")) continue;
    const seg = raw.replace(/_$/, "");
    if (seg === "$") segs.push("[...slug]");
    else if (seg.startsWith("$")) segs.push(`[${seg.slice(1)}]`);
    else segs.push(seg);
  }
  return `/${segs.join("/")}`;
}

export function isViteProject(projectRoot: string): boolean {
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!deps.vite && !deps.next;
  } catch {
    return false;
  }
}

function modulePath(projectRoot: string, id: string): string {
  const clean = id.split("?")[0];
  if (!isAbsolute(clean)) return normalizeModulePath(clean);
  return normalizeModulePath(relative(realpathSync(projectRoot), clean));
}

/** Runs `vite build` in-process (no files written) and builds a graph from Rollup's chunks and module edges. */
export async function buildGraphFromVite(projectRoot: string): Promise<ParsedGraph> {
  const req = createRequire(join(projectRoot, "package.json"));
  let vite: ViteApi;
  try {
    vite = (await import(pathToFileURL(req.resolve("vite")).href)) as ViteApi;
  } catch {
    throw new Error("Could not resolve 'vite' from the project. Install it or run from the project root.");
  }

  const edges = new Map<string, { sync: Set<string>; async: Set<string> }>();
  const chunks: ViteChunk[] = [];
  const plugin = {
    name: "wimb-collect",
    generateBundle(
      this: { getModuleInfo(id: string): ViteModuleInfo | null },
      _o: unknown,
      bundle: Record<string, ViteBundleItem>,
    ) {
      for (const entry of Object.values(bundle)) {
        if (entry.type !== "chunk") continue;
        const item = entry as ViteChunk;
        chunks.push(item);
        for (const id of Object.keys(item.modules)) {
          const info = this.getModuleInfo(id);
          if (!info || id.startsWith("\0")) continue;
          edges.set(id, {
            sync: new Set(info.importedIds),
            async: new Set(info.dynamicallyImportedIds),
          });
        }
      }
    },
  };
  await vite.build({
    root: realpathSync(projectRoot),
    mode: "production",
    logLevel: "warn",
    plugins: [plugin],
    build: { write: false, emptyOutDir: false, reportCompressedSize: false, watch: null },
  });

  const modules = new Map<string, GraphModule>();
  const idOf = (id: string): string | null => (id.startsWith("\0") ? null : modulePath(projectRoot, id));
  const ensure = (ident: string): GraphModule => {
    let m = modules.get(ident);
    if (!m) {
      m = { type: "module", ident, path: ident, dependencies: { sync: [], async: [], traced: [] } };
      modules.set(ident, m);
    }
    return m;
  };
  for (const [id, e] of edges) {
    const from = idOf(id);
    if (!from) continue;
    const m = ensure(from);
    for (const [set, out] of [[e.sync, m.dependencies.sync], [e.async, m.dependencies.async]] as const) {
      for (const d of set) {
        const to = idOf(d);
        if (to && to !== from) out.push(ensure(to).ident);
      }
    }
  }

  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const routes = new Map<string, GraphRoute>();
  const clientPartsByRoute = new Map<string, Map<string, number>>();
  const pathRouteUsage = new Map<string, Set<string>>();
  // Only static `imports` are followed below, so dynamic (lazy) chunks are excluded from first-load by design.
  const partsOf = (starts: ViteChunk[]): Map<string, number> => {
    const parts = new Map<string, number>();
    const seen = new Set<string>();
    const visit = (c: ViteChunk | undefined) => {
      if (!c || seen.has(c.fileName)) return;
      seen.add(c.fileName);
      const total = Object.values(c.modules).reduce((s, m) => s + m.renderedLength, 0) || 1;
      const ratio = gzipSync(c.code).length / total;
      for (const [id, m] of Object.entries(c.modules)) {
        const p = idOf(id);
        if (!p) continue;
        parts.set(p, (parts.get(p) ?? 0) + m.renderedLength * ratio);
      }
      for (const i of c.imports) visit(byFile.get(i));
    };
    starts.forEach(visit);
    return parts;
  };
  const addRoute = (route: string, facade: string, parts: Map<string, number>) => {
    for (const p of parts.keys()) {
      ensure(p);
      let s = pathRouteUsage.get(p);
      if (!s) pathRouteUsage.set(p, (s = new Set()));
      s.add(route);
    }
    if (facade) ensure(facade);
    routes.set(route, {
      type: "route",
      route,
      entries: [
        {
          route_entry_id: `${route}#client`,
          module_ident: facade,
          module_path: facade,
          role: "route",
          entry_kind: "client_bootstrap",
          client_references: facade ? [{ module_ident: facade, module_path: facade, reference_kind: "ecmascript" }] : [],
        },
      ],
      coverage: { entries: "exact", groups: "unknown" },
    });
    clientPartsByRoute.set(route, new Map([...parts].map(([k, v]) => [k, Math.round(v)])));
  };

  const entries = chunks.filter((c) => c.isEntry);
  // TanStack Router (Start) code-splits each route into `<file>?tsr-split=*` chunks lazily imported from a single entry.
  const splitChunks = new Map<string, ViteChunk[]>();
  for (const c of chunks) {
    const id = tanstackSplitId(c);
    const route = id && routeForTanstackFile(modulePath(projectRoot, id));
    if (!id || !route) continue;
    const key = `${route}\0${modulePath(projectRoot, id)}`;
    splitChunks.set(key, [...(splitChunks.get(key) ?? []), c]);
  }
  if (splitChunks.size) {
    const base = partsOf(entries);
    const grouped = new Map<string, { facade: string; chunks: ViteChunk[] }>();
    for (const [key, cs] of splitChunks) {
      const [route, facade] = key.split("\0");
      const g = grouped.get(route) ?? { facade, chunks: [] };
      g.chunks.push(...cs);
      grouped.set(route, g);
    }
    for (const [route, g] of grouped) {
      const parts = partsOf([...entries, ...g.chunks]);
      addRoute(route, g.facade, parts);
    }
    // Unsplit route files bundled into the entry itself load with the entry.
    for (const id of base.keys()) {
      if (!/(^|\/)routes\//.test(id) || !/\.[jt]sx?$/.test(id)) continue;
      const route = routeForTanstackFile(id);
      if (route && !routes.has(route)) addRoute(route, id, base);
    }
    return finish();
  }
  for (const entry of entries) {
    const facadeId = entry.facadeModuleId ? idOf(entry.facadeModuleId) : null;
    let route = routeForEntry(facadeId ?? "", entry.name);
    for (let n = 2; routes.has(route); n++) route = `${routeForEntry(facadeId ?? "", entry.name)}-${n}`;
    addRoute(route, facadeId || "", partsOf([entry]));
  }
  return finish();

  function finish(): ParsedGraph {
    return {
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
  }
}
