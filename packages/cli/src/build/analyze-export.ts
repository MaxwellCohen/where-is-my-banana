import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { ByteAttribution } from "../types.js";
import { normalizeModulePath, packageNameFromPath } from "./module-path.js";

/**
 * Next.js 16.4+ `next analyze export` streams graph-v1 records as JSON Lines.
 * Schema: `next/analyze/graph-v1.schema.json` in the installed Next.js package.
 *
 * Sizes are attributed build bytes, not observed network transfer.
 */

interface AnalyzePart {
  type: "part";
  route: string;
  filename: string;
  source_path: string;
  size: number;
  compressed_size: number;
}

interface RouteTotals {
  size: number;
  compressed: number;
}

export function isClientJavaScriptOutput(filename: string): boolean {
  return filename.startsWith("[client-fs]/") && filename.endsWith(".js");
}

/** Fold graph-v1 JSONL into the route/module byte maps the rest of wimb uses. */
export function parseAnalyzeExportJsonl(jsonl: string): ByteAttribution {
  const acc = createExportAccumulator();
  for (const line of jsonl.split("\n")) acc.addLine(line);
  return acc.finish();
}

export function parseAnalyzeExportFile(filePath: string): ByteAttribution {
  const buf = readFileSync(filePath);
  const text = filePath.endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
  return parseAnalyzeExportJsonl(text);
}

export function createExportAccumulator() {
  const routeTotals = new Map<string, RouteTotals>();
  const perRouteModules = new Map<string, Map<string, number>>();
  let sawPart = false;

  return {
    addLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: { type?: string };
      try {
        record = JSON.parse(trimmed) as { type?: string };
      } catch {
        return;
      }
      if (record.type !== "part") return;
      ingestPart(record as AnalyzePart, routeTotals, perRouteModules);
      sawPart = true;
    },
    finish(): ByteAttribution {
      const routes = new Map<string, number>();
      for (const [route, totals] of routeTotals) {
        routes.set(route, totals.compressed > 0 ? totals.compressed : totals.size);
      }

      const modules = new Map<string, number>();
      for (const routeModules of perRouteModules.values()) {
        for (const [path, bytes] of routeModules) {
          const prev = modules.get(path) ?? 0;
          if (bytes > prev) modules.set(path, bytes);
        }
      }

      return {
        routes,
        modules,
        measured: sawPart,
        format: "export",
      };
    },
  };
}

function ingestPart(
  part: AnalyzePart,
  routeTotals: Map<string, RouteTotals>,
  perRouteModules: Map<string, Map<string, number>>,
): void {
  if (!part.route) return;
  const size = numberOrZero(part.size);
  const compressed = numberOrZero(part.compressed_size);
  const totals = routeTotals.get(part.route) ?? { size: 0, compressed: 0 };
  totals.size += size;
  totals.compressed += compressed;
  routeTotals.set(part.route, totals);

  if (!isClientJavaScriptOutput(part.filename ?? "")) return;

  const path = normalizeModulePath(part.source_path ?? "");
  if (!path) return;
  const bytes = compressed > 0 ? compressed : size;
  addModuleBytes(perRouteModules, part.route, path, bytes);

  const pkg = packageNameFromPath(path);
  if (pkg) addModuleBytes(perRouteModules, part.route, pkg, bytes);
}

function addModuleBytes(
  perRouteModules: Map<string, Map<string, number>>,
  route: string,
  key: string,
  bytes: number,
): void {
  let routeModules = perRouteModules.get(route);
  if (!routeModules) {
    routeModules = new Map();
    perRouteModules.set(route, routeModules);
  }
  routeModules.set(key, (routeModules.get(key) ?? 0) + bytes);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
