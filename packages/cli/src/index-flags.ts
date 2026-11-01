import type { WinsReport } from "./wins/types.js";

export class FlagError extends Error {}

export const FORMATS = ["json", "md"] as const;
export const EXIT_THRESHOLDS = ["error", "warning", "info"] as const;
export type ExitThreshold = (typeof EXIT_THRESHOLDS)[number];

/** Parse an optional numeric flag; throws FlagError unless it is a finite number >= 0. */
export function parseNumberFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new FlagError(`--${name} must be a non-negative number, got '${value}'`);
  return n;
}

export function parseFormats(value: string): string[] {
  const formats = value.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = formats.filter((f) => !(FORMATS as readonly string[]).includes(f));
  if (bad.length || formats.length === 0) {
    throw new FlagError(`--format must be a comma-separated subset of ${FORMATS.join(",")}, got '${value}'`);
  }
  return formats;
}

export function parseExitThreshold(value: string): ExitThreshold {
  if (!(EXIT_THRESHOLDS as readonly string[]).includes(value)) {
    throw new FlagError(`--exit-threshold must be one of ${EXIT_THRESHOLDS.join("|")}, got '${value}'`);
  }
  return value as ExitThreshold;
}

/** Minimal shape check for a previous wins.json passed to --compare. */
export function validateWinsReport(data: unknown, source: string): WinsReport {
  const r = data as Partial<WinsReport> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.routes) || !Array.isArray(r.wins)) {
    throw new FlagError(`--compare ${source} is not a wimb wins report (missing routes/wins)`);
  }
  return r as WinsReport;
}
