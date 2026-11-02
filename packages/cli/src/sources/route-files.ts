import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeModulePath } from "@wimb/graph-v1";

/** A route-file module recognised in a lazily loaded bundler chunk. */
export type RouteFile =
  | { kind: "page"; framework: string; route: string; dir: string; file: string }
  | { kind: "layout"; framework: string; dir: string }
  | { kind: "skip"; framework: string };

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

/** URL for a directory-based route (SvelteKit / SolidStart): groups dropped, `index` dropped. */
function dirRoute(segments: string[]): string {
  const segs = segments.filter((s) => s && s !== "index" && !/^\(.*\)$/.test(s));
  return `/${segs.join("/")}`;
}

function splitAfterRoutes(rel: string): { dir: string; rest: string[] } | null {
  const m = /(^|\/)routes\/(.*)$/.exec(rel);
  return m ? { dir: rel.slice(0, rel.length - m[2].length), rest: m[2].split("/") } : null;
}

/**
 * Classifies a module of a bundled chunk as a lazily loaded route file.
 * `raw` is the bundler id (with query); `rel` is the project-relative path without query.
 */
export function classifyRouteChunk(raw: string, rel: string, prachtUrlFor?: (rel: string) => string | undefined): RouteFile | null {
  // Pracht: `src/routes/x.tsx?pracht-client`; URLs live in the app's route table, shells wrap routes.
  if (raw.includes("?pracht-client")) {
    if (/(^|\/)shells\//.test(rel)) return { kind: "layout", framework: "pracht", dir: "" };
    const url = prachtUrlFor?.(rel);
    if (url) return { kind: "page", framework: "pracht", route: url, dir: "", file: rel };
    return prachtUrlFor ? { kind: "skip", framework: "pracht" } : { kind: "page", framework: "pracht", route: dirRoute([rel.replace(/^.*routes\//, "").replace(/\.[^./]+$/, "")]), dir: "", file: rel };
  }
  // TanStack Router auto code-splitting: `routes/x.tsx?tsr-split=component`.
  if (raw.includes("?tsr-split=")) {
    const route = routeForTanstackFile(rel);
    return route ? { kind: "page", framework: "tanstack", route, dir: "", file: rel } : null;
  }
  // SvelteKit client nodes: `src/routes/<dir>/+page.svelte` / `+layout.svelte` / `+error.svelte`.
  const sv = /(^|\/)routes\/(?:(.*)\/)?(\+page|\+layout|\+error)(?:@[^.]*)?\.svelte$/.exec(rel);
  if (sv) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    if (sv[3] === "+error") return { kind: "skip", framework: "sveltekit" };
    if (sv[3] === "+layout") return { kind: "layout", framework: "sveltekit", dir };
    return { kind: "page", framework: "sveltekit", route: dirRoute(sv[2] ? sv[2].split("/") : []), dir, file: rel };
  }
  // SolidStart file routes: `routes/blog/[slug].tsx?pick=default&pick=$css`.
  if (raw.includes("?pick=")) {
    const r = splitAfterRoutes(rel.replace(/\.[^./]+$/, ""));
    return r ? { kind: "page", framework: "solid-start", route: dirRoute(r.rest), dir: "", file: rel } : null;
  }
  return null;
}

/** Best-effort `route('/path', './routes/file.tsx')` table from a Pracht app's route manifest, keyed by project-relative file. */
export function readPrachtRoutes(projectRoot: string): Map<string, string> | undefined {
  for (const f of ["src/routes.ts", "src/pracht-routes.ts"]) {
    const abs = join(projectRoot, f);
    if (!existsSync(abs)) continue;
    const table = new Map<string, string>();
    for (const m of readFileSync(abs, "utf-8").matchAll(/route\(\s*['"]([^'"]*)['"]\s*,\s*['"]\.\/([^'"]+)['"]/g)) {
      table.set(normalizeModulePath(`src/${m[2]}`), m[1].replace(/:(\w+)/g, "[$1]") || "/");
    }
    if (table.size) return table;
  }
  return undefined;
}
