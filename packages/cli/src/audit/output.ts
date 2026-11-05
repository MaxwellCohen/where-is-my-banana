import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditReport, Finding, Severity } from "./types.js";
import { CHECKS } from "./types.js";
import { priority } from "./score.js";

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const loc = (f: Finding) => `${f.file}:${f.line}`;
const tag = (f: Finding) => (f.impactScore !== undefined ? ` (impact ${f.impactScore}, effort ${f.effort})` : "") + (f.package ? ` [${f.package}]` : "");

export function sortFindings(findings: Finding[]): Finding[] {
  const order = (c: string) => CHECKS.indexOf(c as (typeof CHECKS)[number]);
  return [...findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || order(a.check) - order(b.check) || a.file.localeCompare(b.file) || a.line - b.line,
  );
}

/** Top-N "do these first": ranked by impact/effort, at most 2 per check on the first pass. */
export function doFirst(sorted: Finding[], n = 10): Finding[] {
  const ranked = [...sorted].sort((a, b) => priority(b) - priority(a) || (b.impactScore ?? 0) - (a.impactScore ?? 0));
  const picked: Finding[] = [];
  const perCheck = new Map<string, number>();
  for (const f of ranked) {
    if (picked.length >= n) break;
    const c = perCheck.get(f.check) ?? 0;
    if (c >= 2) continue;
    perCheck.set(f.check, c + 1);
    picked.push(f);
  }
  for (const f of ranked) {
    if (picked.length >= n) break;
    if (!picked.includes(f)) picked.push(f);
  }
  return picked.sort((a, b) => priority(b) - priority(a) || (b.impactScore ?? 0) - (a.impactScore ?? 0));
}

export function buildReport(projectRoot: string, findings: Finding[]): AuditReport {
  const sorted = sortFindings(findings);
  const byCheck: Record<string, number> = {};
  for (const f of sorted) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    summary: {
      high: sorted.filter((f) => f.severity === "high").length,
      medium: sorted.filter((f) => f.severity === "medium").length,
      low: sorted.filter((f) => f.severity === "low").length,
      byCheck,
    },
    findings: sorted,
  };
}

export function formatAuditMarkdown(report: AuditReport, top = 10): string {
  const L: string[] = [];
  const s = report.summary;
  L.push("# wimb audit", "");
  L.push(`Generated ${report.generatedAt}. ${s.high} high, ${s.medium} medium, ${s.low} low.${report.baselined ? ` ${report.baselined} baselined finding(s) hidden.` : ""}`, "");
  if (report.packages) L.push(`Monorepo: audited ${report.packages.join(", ")}.`, "");
  L.push("Static checks only. For registry/boundary/barrel rules (static-component-map, use-client-too-high, barrel-import, runtime-css-in-js, heavy-client-import) run `wimb scan`; for measured bundle edges run `wimb wins`.", "");
  const first = doFirst(report.findings);
  L.push("## Do these first", "");
  if (first.length === 0) L.push("No findings.", "");
  first.forEach((f, i) => {
    L.push(`${i + 1}. **[${f.severity}] ${f.check}** \`${loc(f)}\`${tag(f)}: ${f.message}`, `   - Fix: ${f.fix}`);
  });
  L.push("");
  for (const sev of ["high", "medium", "low"] as const) {
    const ofSev = report.findings.filter((f) => f.severity === sev);
    if (!ofSev.length) continue;
    L.push(`## ${sev[0].toUpperCase()}${sev.slice(1)} severity (${ofSev.length})`, "");
    for (const check of CHECKS) {
      const items = ofSev.filter((f) => f.check === check);
      if (!items.length) continue;
      L.push(`### ${check} (${items.length})`, "");
      for (const f of items.slice(0, top)) {
        L.push(`- \`${loc(f)}\`${tag(f)}: ${f.message}`, `  - Fix: ${f.fix}`);
      }
      if (items.length > top) L.push(`- ...and ${items.length - top} more (see audit.json)`);
      L.push("");
    }
  }
  L.push(...splitTable(report.findings));
  return L.join("\n");
}

/** "Files worth breaking up": top split-candidate files (one row per file) with the facts behind them. */
export function splitTable(findings: Finding[], n = 15): string[] {
  const byFile = new Map<string, Finding>();
  for (const f of findings) {
    if (f.check !== "split-candidate" || !f.evidence) continue;
    const key = `${f.package ?? ""}|${f.file}`;
    const cur = byFile.get(key);
    if (!cur || RANK[f.severity] < RANK[cur.severity] || (RANK[f.severity] === RANK[cur.severity] && (f.impactScore ?? 0) > (cur.impactScore ?? 0))) byFile.set(key, f);
  }
  const rows = [...byFile.values()].sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0) || b.evidence!.loc - a.evidence!.loc).slice(0, n);
  if (!rows.length) return [];
  const L = ["## Files worth breaking up", "", `Top ${rows.length} by impact. Clusters = groups of declarations sharing no local state/helpers; heavy imports are packages only one cluster needs. Details and the split plan are in the findings above and in audit.json.`, ""];
  L.push("| File | LOC | Decls | Clusters | Heavy imports unique to a cluster | Client? | Est. KB |", "| --- | ---: | ---: | ---: | --- | --- | ---: |");
  for (const f of rows) {
    const e = f.evidence!;
    L.push(`| \`${f.file}\`${f.package ? ` [${f.package}]` : ""} | ${e.loc} | ${e.declarations} | ${e.clusters.length} | ${e.uniqueHeavy.join(", ") || "-"} | ${e.client ? "use client" : e.clientReachable ? "reachable" : "server"} | ${e.measuredKB ?? "-"} |`);
  }
  L.push("");
  return L;
}

export function formatAuditTerminal(report: AuditReport, top = 10): string {
  const s = report.summary;
  const L = [`wimb audit: ${s.high} high, ${s.medium} medium, ${s.low} low${report.baselined ? ` (${report.baselined} baselined hidden)` : ""}`];
  for (const f of doFirst(report.findings, Math.min(top, 10))) {
    L.push(`  [${f.severity}] ${f.check}  ${loc(f)}${tag(f)}  ${f.message}`);
  }
  return L.join("\n");
}

export function writeAudit(projectRoot: string, report: AuditReport, top: number): { json: string; md: string } {
  const dir = join(projectRoot, ".wimb");
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "audit.json");
  const md = join(dir, "audit.md");
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(md, formatAuditMarkdown(report, top));
  return { json, md };
}
