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
  /** Version string from the input report (e.g. "2"); "unknown" if absent. */
  version: string;
  /** Number of wins in the input that were too malformed to load. */
  droppedWins: number;
  timestamp: string;
  projectRoot: string;
  byteSource: "measured" | "estimated";
  routes: { route: string; firstLoadBytes: number }[];
  wins: Win[];
}

const FIX_KINDS: FixKind[] = ["lazy", "move-to-server", "swap-package", "deep-import", "remove"];
const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseWin(v: unknown): Win | null {
  if (!isObj(v) || typeof v.id !== "string") return null;
  if (!FIX_KINDS.includes(v.fixKind as FixKind)) return null;
  if (!isStrArr(v.chain)) return null;
  if (!isNum(v.totalSavedBytes)) return null;
  const edge = v.edge;
  if (!isObj(edge) || typeof edge.importer !== "string" || typeof edge.imported !== "string") return null;
  if (edge.packageName !== null && typeof edge.packageName !== "string") return null;
  if (!isObj(v.routes)) return null;
  const routes: Record<string, number> = {};
  for (const [k, n] of Object.entries(v.routes)) if (isNum(n)) routes[k] = n;
  const edit = v.edit;
  if (!isObj(edit) || typeof edit.summary !== "string" || !isStrArr(edit.steps)) return null;
  const safety: Safety = v.safety === "safe" ? "safe" : "needs-review";
  const safetyReasons = isStrArr(v.safetyReasons) ? v.safetyReasons : [];
  const usage = typeof v.usage === "string" ? v.usage : "unknown";
  const cleanEdit: WinEdit = {
    summary: edit.summary,
    steps: edit.steps,
    verify: typeof edit.verify === "string" ? edit.verify : "",
    replacementImport: typeof edit.replacementImport === "string" ? edit.replacementImport : undefined,
    originalImport: typeof edit.originalImport === "string" ? edit.originalImport : undefined,
  };
  const loc = isObj(v.loc) && isNum(v.loc.line) && isNum(v.loc.column) ? (v.loc as Win["loc"]) : undefined;
  return {
    ...(v as unknown as Win),
    safety,
    safetyReasons,
    usage,
    routes,
    edit: cleanEdit,
    loc,
    byteSource: v.byteSource === "measured" ? "measured" : "estimated",
  };
}

/** Validate a parsed wins.json; tolerates missing optional fields, drops unrecoverable wins (counted in droppedWins), throws if the envelope is wrong. */
export function parseWinsReport(parsed: unknown): WinsReport {
  if (!isObj(parsed) || !Array.isArray(parsed.wins) || !Array.isArray(parsed.routes)) {
    throw new Error("JSON must be a wimb WinsReport (wins.json)");
  }
  const routes = parsed.routes.filter(
    (r): r is { route: string; firstLoadBytes: number } =>
      isObj(r) && typeof r.route === "string" && isNum(r.firstLoadBytes),
  );
  const wins = parsed.wins.map(parseWin).filter((w): w is Win => w !== null);
  return {
    version: typeof parsed.version === "string" ? parsed.version : "unknown",
    droppedWins: parsed.wins.length - wins.length,
    timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    projectRoot: typeof parsed.projectRoot === "string" ? parsed.projectRoot : "",
    byteSource: parsed.byteSource === "measured" ? "measured" : "estimated",
    routes,
    wins,
  };
}

export async function loadWinsFromFile(file: File): Promise<WinsReport> {
  if (file.size > 50 * 1024 * 1024) throw new Error("wins.json is too large (limit 50 MB)");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("File is not valid JSON");
  }
  return parseWinsReport(parsed);
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
