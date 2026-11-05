import type { Win, WinsReport } from "./types.js";

export interface RouteDelta {
  route: string;
  before: number;
  after: number;
  delta: number;
  /** present when both reports carry dynamic accounting */
  preloadedBefore?: number;
  preloadedAfter?: number;
  preloadedDelta?: number;
}

export interface WinsComparison {
  routes: RouteDelta[];
  resolved: Win[];
  introduced: Win[];
}

export function compareWins(before: WinsReport, after: WinsReport): WinsComparison {
  const b = new Map(before.routes.map((r) => [r.route, r.firstLoadBytes]));
  const a = new Map(after.routes.map((r) => [r.route, r.firstLoadBytes]));
  const bp = new Map(before.routes.map((r) => [r.route, r.preloadedBytes]));
  const ap = new Map(after.routes.map((r) => [r.route, r.preloadedBytes]));
  const routes: RouteDelta[] = [];
  for (const route of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    if (!b.has(route) || !a.has(route)) continue;
    const bb = b.get(route)!;
    const aa = a.get(route)!;
    const pb = bp.get(route);
    const pa = ap.get(route);
    routes.push({
      route,
      before: bb,
      after: aa,
      delta: aa - bb,
      ...(pb !== undefined && pa !== undefined ? { preloadedBefore: pb, preloadedAfter: pa, preloadedDelta: pa - pb } : {}),
    });
  }
  const beforeIds = new Set(before.wins.map((w) => w.id));
  const afterIds = new Set(after.wins.map((w) => w.id));
  return {
    routes,
    resolved: before.wins.filter((w) => !afterIds.has(w.id)),
    introduced: after.wins.filter((w) => !beforeIds.has(w.id)),
  };
}

export interface BudgetOptions {
  routeBudgetBytes?: number;
  maxSafeWinBytes?: number;
}

export interface BudgetViolation {
  kind: "route-over-budget" | "safe-wins-over-limit";
  message: string;
}

export function checkBudget(report: WinsReport, opts: BudgetOptions): BudgetViolation[] {
  const out: BudgetViolation[] = [];
  if (opts.routeBudgetBytes != null) {
    for (const r of report.routes) {
      if (r.firstLoadBytes > opts.routeBudgetBytes) {
        out.push({
          kind: "route-over-budget",
          message: `${r.route}: ${r.firstLoadBytes} bytes first-load exceeds budget ${opts.routeBudgetBytes}`,
        });
      }
    }
  }
  if (opts.maxSafeWinBytes != null) {
    const safe = report.wins.filter((w) => w.safety === "safe").reduce((s, w) => s + (w.predictedSavedBytes ?? w.totalSavedBytes), 0);
    if (safe > opts.maxSafeWinBytes) {
      out.push({
        kind: "safe-wins-over-limit",
        message: `${safe} bytes of safe wins available exceeds limit ${opts.maxSafeWinBytes}`,
      });
    }
  }
  return out;
}
