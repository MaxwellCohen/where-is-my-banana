import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chainFrom, type RouteGraph } from "./reach.js";
import { findImportLine, isBarrelSource } from "./usage-analyze.js";
import type { BarrelFinding, Win } from "./types.js";

const MAX_IMPORTERS = 10;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Barrels (index files that re-export many modules) keep a module statically reachable even after it is
 * lazy-loaded, or block a proposed lazy edit. Findings cover (a) dynamic import() targets that are also in the static
 * closure through a barrel and (b) lazy wins whose alsoReachableVia chains pass through a barrel.
 * Annotates the affected wins in place (reason + barrel info + first step).
 */
export async function findBarrelDefeats(rgs: RouteGraph[], wins: Win[], projectRoot: string): Promise<BarrelFinding[]> {
  const src = new Map<string, string | null>();
  const text = async (p: string) => {
    if (!src.has(p)) src.set(p, p.includes("node_modules/") ? null : await readText(join(projectRoot, p)));
    return src.get(p)!;
  };
  const barrelCache = new Map<string, boolean>();
  const isBarrel = async (p: string) => {
    let b = barrelCache.get(p);
    if (b === undefined) {
      const t = await text(p);
      b = !!t && isBarrelSource(p, t);
      barrelCache.set(p, b);
    }
    return b;
  };
  const importersOf = async (rg: RouteGraph, barrel: string, avoid: string): Promise<BarrelFinding["importers"]> => {
    const found: BarrelFinding["importers"] = [];
    for (let i = 1; i < rg.idents.length && found.length < MAX_IMPORTERS; i++) {
      if (rg.paths[i] !== barrel) continue;
      for (const p of rg.preds[i]) {
        const file = rg.paths[p];
        if (!file || file.includes("node_modules/") || file === avoid || found.some((f) => f.file === file)) continue;
        const t = await text(file);
        const loc = t ? findImportLine(file, t, { importer: file, imported: barrel, packageName: null }) : undefined;
        found.push({ file, ...(loc ? { line: loc.line } : {}) });
        if (found.length >= MAX_IMPORTERS) break;
      }
    }
    return found;
  };
  const barrelOnChain = async (chain: string[]): Promise<string | null> => {
    for (let i = chain.length - 2; i >= 1; i--) if (await isBarrel(chain[i])) return chain[i];
    return null;
  };

  const findings = new Map<string, BarrelFinding>();
  const add = async (rg: RouteGraph, kind: BarrelFinding["kind"], target: string, chain: string[], barrel: string) => {
    const key = `${kind}\0${target}\0${barrel}`;
    const prior = findings.get(key);
    if (prior) {
      if (!prior.routes.includes(rg.route)) prior.routes.push(rg.route);
      return;
    }
    const importers = await importersOf(rg, barrel, target);
    findings.set(key, {
      target,
      barrel,
      kind,
      chain,
      routes: [rg.route],
      importers,
      fix: `${target} is still reachable statically via ${barrel} (barrel). Import it directly from ${target} in the importers listed (instead of from the barrel), or split ${barrel} so it no longer re-exports ${target}.`,
    });
  };

  for (const rg of rgs) {
    for (const ref of rg.dynamicRefs) {
      if (!ref.alsoStatic) continue;
      const idx = rg.paths.findIndex((p, i) => i > 0 && p === ref.imported);
      if (idx < 0 || rg.parent[idx] === -1) continue;
      const chain = chainFrom(rg, rg.parent, idx);
      const barrel = await barrelOnChain(chain);
      if (barrel) await add(rg, "already-lazy", ref.imported, chain, barrel);
    }
  }
  const byRoute = new Map(rgs.map((r) => [r.route, r]));
  for (const w of wins) {
    if (w.fixKind !== "lazy" || !w.alsoReachableVia?.length) continue;
    for (const chain of w.alsoReachableVia) {
      const barrel = await barrelOnChain(chain);
      if (!barrel) continue;
      const rg = byRoute.get(Object.keys(w.routes)[0] ?? "") ?? rgs[0];
      if (!rg) continue;
      await add(rg, "proposed-lazy", w.edge.imported, chain, barrel);
      const f = findings.get(`proposed-lazy\0${w.edge.imported}\0${barrel}`)!;
      w.barrel = { barrel, importers: f.importers };
      if (!w.safetyReasons.includes("barrel-defeats-lazy")) w.safetyReasons.push("barrel-defeats-lazy");
      w.safety = "needs-review";
      w.edit.steps.unshift(
        `${w.edge.imported} is still reachable statically via ${barrel} (barrel): import it directly from the component file in ${f.importers.length ? f.importers.map((i) => `${i.file}${i.line ? `:${i.line}` : ""}`).join(", ") : "the importers of the barrel"}, or split the barrel, otherwise lazy-loading saves nothing.`,
      );
      break;
    }
  }
  return [...findings.values()];
}

export function formatBarrelsMarkdown(barrels: BarrelFinding[]): string[] {
  if (!barrels.length) return [];
  const out = ["## Barrels that defeat lazy loading", "", "Fix these first: lazy-loading a module that a barrel re-exports saves nothing while any importer still goes through the barrel.", ""];
  for (const b of barrels) {
    out.push(`### ${b.target} via ${b.barrel} (${b.kind === "already-lazy" ? "already lazy-loaded" : "proposed lazy win"})`, "");
    out.push(`- ${b.target} is still reachable statically via ${b.barrel} (barrel)`);
    out.push(`- Chain: ${b.chain.join(" -> ")}`);
    out.push(`- Routes: ${b.routes.join(", ")}`);
    if (b.importers.length) {
      out.push("- Importers to rewrite (import from the component file directly):");
      for (const i of b.importers) out.push(`  - \`${i.file}${i.line ? `:${i.line}` : ""}\``);
    }
    out.push(`- Fix: ${b.fix}`, "");
  }
  return out;
}
