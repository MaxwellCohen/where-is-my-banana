export type FixKind = "lazy" | "move-to-server" | "swap-package" | "deep-import" | "remove";
export type Safety = "safe" | "needs-review";

export interface WinEdit {
  summary: string;
  replacementImport?: string;
  originalImport?: string;
  steps: string[];
  verify: string;
}

export interface Win {
  id: string;
  fixKind: FixKind;
  safety: Safety;
  safetyReasons: string[];
  usage: string;
  edge: { importer: string; imported: string; packageName: string | null };
  loc?: { line: number; column: number };
  routes: Record<string, number>;
  totalSavedBytes: number;
  byteSource: "measured" | "estimated";
  chain: string[];
  edit: WinEdit;
}

export interface WinsReport {
  version: "2";
  timestamp: string;
  projectRoot: string;
  byteSource: "measured" | "estimated";
  routes: { route: string; firstLoadBytes: number }[];
  wins: Win[];
}

export async function loadWinsFromFile(file: File): Promise<WinsReport> {
  const parsed = JSON.parse(await file.text()) as Partial<WinsReport>;
  if (!parsed || !Array.isArray(parsed.wins) || !Array.isArray(parsed.routes)) {
    throw new Error("JSON must be a wimb WinsReport (wins.json)");
  }
  return parsed as WinsReport;
}

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

export function pathsMatch(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export function winsForRoute(report: WinsReport | null, route: string): Win[] {
  return report ? report.wins.filter((w) => route in w.routes) : [];
}

export function safeSavings(report: WinsReport | null, route: string): number {
  return winsForRoute(report, route)
    .filter((w) => w.safety === "safe")
    .reduce((s, w) => s + (w.routes[route] ?? 0), 0);
}

export function firstLoadBytes(report: WinsReport | null, route: string): number | undefined {
  return report?.routes.find((r) => r.route === route)?.firstLoadBytes;
}

export function editPrompt(w: Win): string {
  const lines = [w.edit.summary];
  lines.push(`File: ${w.edge.importer}${w.loc ? `:${w.loc.line}` : ""}`);
  if (w.edit.originalImport) lines.push(`Replace: ${w.edit.originalImport}`);
  if (w.edit.replacementImport) lines.push(`With: ${w.edit.replacementImport}`);
  w.edit.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push(`Verify: ${w.edit.verify}`);
  return lines.join("\n");
}
