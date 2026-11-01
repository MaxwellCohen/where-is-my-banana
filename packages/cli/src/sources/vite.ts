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
  for (const entry of chunks.filter((c) => c.isEntry)) {
    const facadeId = entry.facadeModuleId ? idOf(entry.facadeModuleId) : null;
    let route = routeForEntry(facadeId ?? "", entry.name);
    for (let n = 2; routes.has(route); n++) route = `${routeForEntry(facadeId ?? "", entry.name)}-${n}`;
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
    visit(entry);
    for (const p of parts.keys()) {
      ensure(p);
      let s = pathRouteUsage.get(p);
      if (!s) pathRouteUsage.set(p, (s = new Set()));
      s.add(route);
    }
    const facade = facadeId || "";
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
  }

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
