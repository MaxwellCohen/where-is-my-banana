import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ByteAttribution } from "../types.js";
import { parseNextConfig } from "../config.js";

export interface BuildOptions {
  projectRoot: string;
  distDir?: string;
  skipBuild?: boolean;
}

export function resolveDistDir(projectRoot: string, flag?: string): string {
  if (flag) return join(projectRoot, flag);
  const nextConfig = parseNextConfig(projectRoot);
  return join(projectRoot, nextConfig?.distDir ?? ".next");
}

export async function runBuildAnalysis(opts: BuildOptions): Promise<ByteAttribution | null> {
  const distDir = opts.distDir ?? resolveDistDir(opts.projectRoot);
  const analyzeDir = join(distDir, "diagnostics", "analyze");

  if (!opts.skipBuild && !existsSync(analyzeDir)) {
    try {
      execSync("npx next experimental-analyze --output", {
        cwd: opts.projectRoot,
        stdio: "pipe",
        env: { ...process.env, TURBOPACK_STATS: "1" },
      });
    } catch {
      // build may fail in test environments — fall through to parse attempt
    }
  }

  if (!existsSync(analyzeDir)) {
    const statsPath = join(distDir, "server", "webpack-stats.json");
    if (existsSync(statsPath)) {
      return parseWebpackStats(statsPath);
    }
    console.error(
      `wimb: analyze artifacts not found at ${analyzeDir}. Run 'next experimental-analyze --output' or pass --dist-dir.`,
    );
    return null;
  }

  return parseAnalyzeDir(analyzeDir);
}

function parseAnalyzeDir(dir: string): ByteAttribution {
  const routes = new Map<string, number>();
  const modules = new Map<string, number>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
        route?: string;
        size?: number;
        modules?: { name: string; size: number }[];
      };
      if (data.route && data.size) routes.set(data.route, data.size);
      if (data.modules) {
        for (const m of data.modules) modules.set(m.name, m.size);
      }
    } catch {
      // skip malformed
    }
  }

  return { routes, modules };
}

function parseWebpackStats(path: string): ByteAttribution {
  const routes = new Map<string, number>();
  const modules = new Map<string, number>();
  try {
    const stats = JSON.parse(readFileSync(path, "utf-8")) as {
      chunks?: { names?: string[]; size?: number }[];
      modules?: { name?: string; size?: number }[];
    };
    for (const chunk of stats.chunks ?? []) {
      const name = chunk.names?.[0] ?? "unknown";
      routes.set(name, (routes.get(name) ?? 0) + (chunk.size ?? 0));
    }
    for (const mod of stats.modules ?? []) {
      if (mod.name) modules.set(mod.name, mod.size ?? 0);
    }
  } catch {
    // ignore
  }
  return { routes, modules };
}
