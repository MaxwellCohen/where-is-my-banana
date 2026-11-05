import { packageNameFromPath } from "@wimb/graph-v1";
import type { RouteGraph } from "./reach.js";
import type { PackageRow } from "./types.js";

export const PACKAGE_TABLE_LIMIT = 25;

/** node_modules packages in the client first-load across routes, biggest first. */
export function packageTable(rgs: RouteGraph[], limit = PACKAGE_TABLE_LIMIT): PackageRow[] {
  const agg = new Map<string, { bytes: number; pct: number; routes: number; importers: Map<string, number> }>();
  for (const rg of rgs) {
    const perPkg = new Map<string, { bytes: number; importers: Map<string, number> }>();
    for (let i = 1; i < rg.idents.length; i++) {
      const pkg = packageNameFromPath(rg.paths[i]);
      if (!pkg || rg.bytes[i] <= 0 || rg.parent[i] === -1) continue;
      let e = perPkg.get(pkg);
      if (!e) perPkg.set(pkg, (e = { bytes: 0, importers: new Map() }));
      e.bytes += rg.bytes[i];
      let x = rg.parent[i];
      while (x > 0 && rg.paths[x].includes("node_modules/")) x = rg.parent[x];
      if (x > 0) e.importers.set(rg.paths[x], (e.importers.get(rg.paths[x]) ?? 0) + rg.bytes[i]);
    }
    for (const [pkg, e] of perPkg) {
      let a = agg.get(pkg);
      if (!a) agg.set(pkg, (a = { bytes: 0, pct: 0, routes: 0, importers: new Map() }));
      a.routes++;
      if (e.bytes > a.bytes) {
        a.bytes = e.bytes;
        a.pct = rg.firstLoadBytes > 0 ? (e.bytes / rg.firstLoadBytes) * 100 : 0;
      }
      for (const [f, b] of e.importers) a.importers.set(f, (a.importers.get(f) ?? 0) + b);
    }
  }
  return [...agg.entries()]
    .map(([pkg, a]): PackageRow => ({
      package: pkg,
      bytes: a.bytes,
      pct: Math.round(a.pct * 10) / 10,
      routes: a.routes,
      topImporter: [...a.importers.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.package.localeCompare(b.package))
    .slice(0, limit);
}

export function formatPackageTable(rows: PackageRow[]): string[] {
  if (rows.length === 0) return ["No node_modules packages in client first-load."];
  const data = [["package", "KB (gzip)", "% of route", "routes", "top importer"], ...rows.map((r) => [r.package, (r.bytes / 1024).toFixed(1), `${r.pct.toFixed(1)}%`, String(r.routes), r.topImporter ?? "-"])];
  const w = data[0].map((_, c) => Math.max(...data.map((r) => r[c].length)));
  return data.map((r) => r.map((cell, c) => (c === r.length - 1 || c === 0 ? cell.padEnd(c === 0 ? w[0] : 0) : cell.padStart(w[c]))).join("  ").trimEnd());
}

export function formatPackageMarkdown(rows: PackageRow[]): string[] {
  const out = ["## Packages in client first-load", ""];
  if (rows.length === 0) return [...out, "None.", ""];
  out.push("| Package | KB (gzip) | % of route | Routes | Top importer |", "| --- | ---: | ---: | ---: | --- |");
  for (const r of rows) out.push(`| ${r.package} | ${(r.bytes / 1024).toFixed(1)} | ${r.pct.toFixed(1)}% | ${r.routes} | ${r.topImporter ? `\`${r.topImporter}\`` : "-"} |`);
  out.push("");
  return out;
}
