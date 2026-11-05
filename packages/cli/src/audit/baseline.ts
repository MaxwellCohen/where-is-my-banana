import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "./types.js";

export interface Baseline {
  version: 1;
  /** fingerprint -> number of occurrences accepted. */
  fingerprints: Record<string, number>;
}

/** Stable across line moves and count changes: id + file + message with digits/quoted values normalized. */
export function fingerprint(f: Pick<Finding, "id" | "file" | "message">): string {
  const msg = f.message
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${f.id}|${f.file}|${msg}`;
}

export function makeBaseline(findings: Finding[]): Baseline {
  const fingerprints: Record<string, number> = {};
  for (const f of findings) {
    const k = fingerprint(f);
    fingerprints[k] = (fingerprints[k] ?? 0) + 1;
  }
  return { version: 1, fingerprints: Object.fromEntries(Object.entries(fingerprints).sort(([a], [b]) => a.localeCompare(b))) };
}

export function readBaseline(path: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read baseline ${path}: ${(err as Error).message}`);
  }
  const b = raw as Partial<Baseline>;
  if (!b || b.version !== 1 || typeof b.fingerprints !== "object" || b.fingerprints === null) {
    throw new Error(`${path} is not a wimb audit baseline (expected {"version":1,"fingerprints":{...}})`);
  }
  return b as Baseline;
}

export function writeBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
}

/** Split findings into new vs. already-baselined (multiset: a 3rd occurrence of a 2x-baselined issue is new). */
export function applyBaseline(findings: Finding[], baseline: Baseline): { fresh: Finding[]; baselined: number } {
  const left = new Map(Object.entries(baseline.fingerprints));
  const fresh: Finding[] = [];
  let baselined = 0;
  for (const f of findings) {
    const k = fingerprint(f);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      baselined++;
    } else fresh.push(f);
  }
  return { fresh, baselined };
}
