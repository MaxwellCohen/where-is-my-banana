import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareWins } from "./compare.js";
import type { Win, WinsReport } from "./types.js";

export type VerifyStatus = "kept" | "failed" | "neutral";

export interface VerifyRouteDelta {
  route: string;
  firstLoad: number;
  preloaded: number;
  onDemand: number;
}

export interface VerifyEntry {
  winId: string;
  status: VerifyStatus;
  deltas: VerifyRouteDelta[];
  reason: string;
  timestamp: string;
}

export interface VerifyFile {
  version: 1;
  results: VerifyEntry[];
}

export const wimbPath = (root: string, name: string) => join(root, ".wimb", name);

export function readVerifyFile(root: string): VerifyFile {
  try {
    const data = JSON.parse(readFileSync(wimbPath(root, "verify.json"), "utf-8")) as Partial<VerifyFile>;
    if (Array.isArray(data.results)) return { version: 1, results: data.results };
  } catch {
    // missing or malformed: treat as empty
  }
  return { version: 1, results: [] };
}

/** Record the latest verdict per win id. */
export function recordVerify(root: string, entry: VerifyEntry): void {
  const f = readVerifyFile(root);
  f.results = [...f.results.filter((r) => r.winId !== entry.winId), entry];
  mkdirSync(dirname(wimbPath(root, "verify.json")), { recursive: true });
  writeFileSync(wimbPath(root, "verify.json"), `${JSON.stringify(f, null, 2)}\n`, "utf-8");
}

/** Win ids whose last verification failed (they were reverted); `wins` demotes them. */
export function failedWinIds(root: string): Set<string> {
  return new Set(readVerifyFile(root).results.filter((r) => r.status === "failed").map((r) => r.winId));
}

/** Annotate and demote wins that failed verification earlier. */
export function applyFailedPreviously(wins: Win[], failed: Set<string>): void {
  if (failed.size === 0) return;
  for (const w of wins) {
    if (!failed.has(w.id)) continue;
    w.status = "failed-previously";
    w.safety = "needs-review";
    if (!w.safetyReasons.includes("failed-previously")) w.safetyReasons.push("failed-previously");
    w.predictedSavedBytes = 0;
  }
}

export interface VerdictOptions {
  tolerance: number;
  win?: Win;
}

export function judge(baseline: WinsReport, after: WinsReport, opts: VerdictOptions): { status: VerifyStatus; deltas: VerifyRouteDelta[]; reason: string } {
  const cmp = compareWins(baseline, after);
  const deltas: VerifyRouteDelta[] = cmp.routes.map((r) => ({
    route: r.route,
    firstLoad: r.delta,
    preloaded: r.preloadedDelta ?? 0,
    onDemand: (after.routes.find((x) => x.route === r.route)?.onDemandBytes ?? 0) - (baseline.routes.find((x) => x.route === r.route)?.onDemandBytes ?? 0),
  }));
  const rose = deltas.filter((d) => d.firstLoad > opts.tolerance);
  if (rose.length) return { status: "failed", deltas, reason: `first-load rose on ${rose.map((d) => `${d.route} (+${d.firstLoad} B)`).join(", ")}` };
  const targets = opts.win ? Object.keys(opts.win.routes) : deltas.map((d) => d.route);
  const improved = deltas.filter((d) => targets.includes(d.route) && d.firstLoad < -opts.tolerance);
  if (improved.length) return { status: "kept", deltas, reason: `first-load dropped on ${improved.map((d) => `${d.route} (${d.firstLoad} B)`).join(", ")}` };
  if (opts.win) return { status: "failed", deltas, reason: `no first-load improvement beyond ${opts.tolerance} B on target routes (${targets.join(", ") || "none"})` };
  return { status: "neutral", deltas, reason: "no change beyond tolerance" };
}

const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const stateFile = (root: string) => wimbPath(root, "verify-state.json");

/** Files a win edits: its importer(s) from the baseline wins.json. */
export function winFiles(win: Win | undefined): string[] {
  if (!win) return [];
  return [...new Set([win.edge.importer])].filter((f) => f && !f.startsWith("node_modules/"));
}

const blobOfWorking = (root: string, file: string): string | null => {
  try {
    return git(root, ["hash-object", "--", file]);
  } catch {
    return null;
  }
};
const blobAtHead = (root: string, file: string): string | null => {
  try {
    return git(root, ["rev-parse", `HEAD:./${file}`]);
  } catch {
    return null;
  }
};

/** Remember each win importer's working-tree hash at baseline time, to detect edits that predate the win. */
export function snapshotFileState(root: string, report: WinsReport): void {
  const hashes: Record<string, string> = {};
  for (const f of new Set(report.wins.flatMap((w) => winFiles(w)))) {
    const h = existsSync(join(root, f)) ? blobOfWorking(root, f) : null;
    if (h) hashes[f] = h;
  }
  mkdirSync(dirname(stateFile(root)), { recursive: true });
  writeFileSync(stateFile(root), `${JSON.stringify({ hashes }, null, 2)}\n`, "utf-8");
}

function readState(root: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(stateFile(root), "utf-8")) as { hashes?: Record<string, string> }).hashes ?? {};
  } catch {
    return {};
  }
}

export interface RevertPlan {
  revert: string[];
  refused: Array<{ file: string; why: string }>;
}

/** Decide which files may be restored with `git checkout --`. Never touches anything else. */
export function planRevert(root: string, files: string[], force = false): RevertPlan {
  const state = readState(root);
  const plan: RevertPlan = { revert: [], refused: [] };
  for (const file of new Set(files)) {
    const head = blobAtHead(root, file);
    if (!head) {
      plan.refused.push({ file, why: "not tracked by git (cannot restore)" });
      continue;
    }
    const base = state[file];
    if (base && base !== head && !force) {
      plan.refused.push({ file, why: "had uncommitted changes before the win was applied; checkout would discard them (rerun with --force-revert to override)" });
      continue;
    }
    if (blobOfWorking(root, file) === head) continue; // already clean
    plan.revert.push(file);
  }
  return plan;
}

export function applyRevert(root: string, plan: RevertPlan): void {
  if (plan.revert.length) git(root, ["checkout", "--", ...plan.revert]);
}

/** Rotate: wins.json becomes the new baseline. */
export function acceptBaseline(root: string): void {
  copyFileSync(wimbPath(root, "wins.json"), wimbPath(root, "wins.prev.json"));
}
