import type { GraphModule, ParsedGraph } from "@wimb/graph-v1";

export interface SynMod {
  path: string;
  sync?: string[];
  async?: string[];
}

/** Synthetic one-or-more-route graph. `routes[route] = { seeds, bytes: path -> bytes }`. */
export function synGraph(
  mods: Record<string, SynMod>,
  routes: Record<string, { seeds: string[]; bytes: Record<string, number> }>,
  server: Record<string, Record<string, number>> = {},
): ParsedGraph {
  const modules = new Map<string, GraphModule>();
  for (const [id, m] of Object.entries(mods)) {
    modules.set(id, {
      type: "module",
      ident: id,
      path: m.path,
      dependencies: { sync: m.sync ?? [], async: m.async ?? [], traced: [] },
    });
  }
  return {
    meta: null,
    modules,
    routes: new Map(
      Object.entries(routes).map(([route, r]) => [
        route,
        {
          type: "route" as const,
          route,
          entries: [
            {
              route_entry_id: `${route}#c`,
              module_ident: r.seeds[0],
              module_path: mods[r.seeds[0]].path,
              role: "route" as const,
              entry_kind: "client_bootstrap" as const,
              client_references: r.seeds.map((id) => ({ module_ident: id, module_path: mods[id].path, reference_kind: "ecmascript" as const })),
            },
          ],
          coverage: { entries: "exact" as const, groups: "exact" as const },
        },
      ]),
    ),
    clientPartsByRoute: new Map(Object.entries(routes).map(([r, v]) => [r, new Map(Object.entries(v.bytes))])),
    serverPartsByRoute: new Map(Object.entries(server).map(([r, v]) => [r, new Map(Object.entries(v))])),
    pathRouteUsage: new Map(),
    serverPathRouteUsage: new Map(),
    outputs: [],
    groups: [],
  };
}
