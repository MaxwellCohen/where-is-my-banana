import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Win, WinsReport } from "./types.js";

const kb = (n: number) => (n / 1024).toFixed(1);
/** What to expect after the fix (older reports have only totalSavedBytes). */
const expected = (w: Win) => w.predictedSavedBytes ?? w.totalSavedBytes;
const viaText = (chains: string[][]) => chains.map((c) => c.map((p) => shortPath(p, 40)).join(" -> ")).join("; ");

function locOf(w: Win): string {
  return `${w.edge.importer}${w.loc ? `:${w.loc.line}` : ""}`;
}

export function shortPath(p: string, max = 60): string {
  const marker = "node_modules/";
  const idx = p.lastIndexOf(marker);
  let s = idx >= 0 ? p.slice(idx + marker.length) : p;
  if (s.length > max) {
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    s = `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
  }
  return s;
}

function shortLoc(w: Win): string {
  return `${shortPath(w.edge.importer, 40)}${w.loc ? `:${w.loc.line}` : ""} -> ${shortPath(w.edge.imported, 40)}`;
}

const COLORS: Record<string, string> = { safe: "\x1b[32m", "needs-review": "\x1b[33m" };

function table(rows: string[][], colorSafetyCol?: number, color = false): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) =>
    r
      .map((cell, c) => {
        const padded = c === r.length - 1 ? cell : cell.padEnd(widths[c]);
        const code = color && c === colorSafetyCol ? COLORS[cell] : undefined;
        return code ? `${code}${padded}\x1b[0m` : padded;
      })
      .join("  ")
      .trimEnd(),
  );
}

export function writeWins(root: string, report: WinsReport): { jsonPath: string; mdPath: string } {
  const dir = join(root, ".wimb");
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, "wins.json");
  const mdPath = join(dir, "wins.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeFileSync(mdPath, formatWinsMarkdown(report), "utf-8");
  return { jsonPath, mdPath };
}

export function formatWinsTerminal(report: WinsReport, opts: { top?: number } = {}): string {
  const top = opts.top ?? 10;
  const lines: string[] = [];
  lines.push("Route first-load JS:");
  for (const r of report.routes) lines.push(`  ${r.route}  ${kb(r.firstLoadBytes)} KB`);
  lines.push("");
  const wins = report.wins.slice(0, top);
  if (wins.length === 0) {
    lines.push("No wins found.");
    return lines.join("\n");
  }
  const firstLoad = new Map(report.routes.map((r) => [r.route, r.firstLoadBytes]));
  const rows: string[][] = [["#", "KB saved", "%", "fix", "safety", "pkg", "location", "routes"]];
  wins.forEach((w, i) => {
    const top = Object.entries(w.routes).sort((a, b) => b[1] - a[1])[0];
    const total = top ? firstLoad.get(top[0]) : undefined;
    const pct = top && total ? `${((Math.min(top[1], expected(w)) / total) * 100).toFixed(1)}%` : "-";
    rows.push([
      String(i + 1),
      kb(expected(w)),
      pct,
      w.fixKind,
      w.safety,
      w.edge.packageName ?? "app",
      shortLoc(w),
      String(Object.keys(w.routes).length),
    ]);
  });
  lines.push(...table(rows, 4, !!process.stdout.isTTY));
  wins.forEach((w, i) => {
    if (w.alsoReachableVia?.length) lines.push(`  #${i + 1} also statically reachable via ${viaText(w.alsoReachableVia)}`);
    if (w.predictedSavedBytes !== undefined && w.predictedSavedBytes < w.totalSavedBytes)
      lines.push(`  #${i + 1} measured ${kb(w.totalSavedBytes)} KB, predicted ${kb(w.predictedSavedBytes)} KB after lazy-loading runtime`);
  });
  if (report.wins.length > top) lines.push(`... ${report.wins.length - top} more (see .wimb/wins.md)`);
  return lines.join("\n");
}

export function formatWinsMarkdown(report: WinsReport): string {
  const out: string[] = [];
  out.push("# wimb wins", "");
  out.push(`Byte source: ${report.byteSource}`, "");
  out.push("## Route first-load JS", "", "| Route | First load (KB) |", "| --- | ---: |");
  for (const r of report.routes) out.push(`| ${r.route} | ${kb(r.firstLoadBytes)} |`);
  out.push("", "## Top wins", "");
  if (report.wins.length === 0) {
    out.push("No wins found.", "");
    return out.join("\n");
  }
  out.push("| # | KB saved | Fix | Safety | Pkg | Location | Routes |", "| ---: | ---: | --- | --- | --- | --- | ---: |");
  report.wins.forEach((w, i) => {
    out.push(
      `| ${i + 1} | ${kb(expected(w))} | ${w.fixKind} | ${w.safety} | ${w.edge.packageName ?? "app"} | \`${shortLoc(w)}\` | ${Object.keys(w.routes).length} |`,
    );
  });
  out.push("", "## Details", "");
  report.wins.forEach((w, i) => {
    out.push(`### ${i + 1}. ${w.edge.imported} (${kb(expected(w))} KB, ${w.fixKind}, ${w.safety})`, "");
    out.push(`- Location: \`${locOf(w)}\``);
    if (w.safetyReasons.length) out.push(`- Reasons: ${w.safetyReasons.join(", ")}`);
    if (w.predictedSavedBytes !== undefined)
      out.push(`- Measured ${kb(w.totalSavedBytes)} KB, predicted ${kb(w.predictedSavedBytes)} KB${w.confidence ? ` (confidence: ${w.confidence})` : ""}`);
    if (w.alsoReachableVia?.length) {
      out.push("- Also statically reachable via (cutting this edge alone will not remove it):");
      for (const c of w.alsoReachableVia) out.push(`  - ${c.join(" -> ")}`);
    }
    out.push(`- Usage: ${w.usage}`);
    out.push(
      `- Routes: ${Object.entries(w.routes)
        .map(([r, b]) => `${r} (${kb(b)} KB)`)
        .join(", ")}`,
    );
    out.push(`- Chain: ${w.chain.join(" -> ")}`, "");
    out.push(w.edit.summary, "");
    if (w.stub) {
      out.push("Turbopack:", "```js", w.stub.turbopackConfig, "```", "", "Webpack:", "```js", w.stub.webpackConfig, "```", "");
      out.push(`Stub file \`${w.stub.stubPath}\`:`, "```js", w.stub.stubContent.trimEnd(), "```", "");
      out.push(`Signals: ${w.stub.signals.join(", ")}; pulled in via ${w.stub.via.join(", ")} (sideEffects: false).`, "");
    }
    if (w.stub) {
      // config shown above
    } else if (w.edit.originalImport) out.push("```ts", `- ${w.edit.originalImport}`, ...(w.edit.replacementImport ? [`+ ${w.edit.replacementImport}`] : []), "```", "");
    else if (w.edit.replacementImport) out.push("```ts", w.edit.replacementImport, "```", "");
    if (w.edit.steps.length) out.push(...w.edit.steps.map((s, n) => `${n + 1}. ${s}`), "");
    out.push(`Verify: \`${w.edit.verify}\``, "");
  });
  return out.join("\n");
}
