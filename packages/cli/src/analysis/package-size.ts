import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ByteAttribution, ModuleGraph, PackageInfo } from "../types.js";
import { resolveOutputDir } from "../paths.js";

interface CacheEntry {
  version: string;
  bytes: number;
  measuredAt: string;
}

interface SizeCache {
  packages: Record<string, CacheEntry>;
}

/**
 * Enrich `pkg.installSizes` for packages reachable from the client graph.
 * Prefer measured bundle attribution when available; otherwise sum package
 * dist files (excluding nested node_modules) and cache under `.wimb/cache.json`.
 */
export async function measureClientPackageSizes(
  projectRoot: string,
  graph: ModuleGraph,
  pkg: PackageInfo,
  byteAttribution: ByteAttribution | null,
): Promise<void> {
  const clientPackages = collectClientPackages(graph);
  if (clientPackages.size === 0) return;

  const cache = loadCache(projectRoot);
  let dirty = false;

  for (const name of clientPackages) {
    // Prefer real bundle attribution when present
    if (byteAttribution?.modules.has(name)) {
      const bytes = byteAttribution.modules.get(name)!;
      pkg.installSizes.set(name, bytes);
      continue;
    }

    const version = resolveInstalledVersion(projectRoot, name) ?? pkg.dependencies[name] ?? "unknown";
    const cacheKey = `${name}@${version}`;
    const cached = cache.packages[cacheKey];
    if (cached) {
      pkg.installSizes.set(name, cached.bytes);
      continue;
    }

    const bytes = measurePackageDir(projectRoot, name);
    pkg.installSizes.set(name, bytes);
    cache.packages[cacheKey] = {
      version,
      bytes,
      measuredAt: new Date().toISOString(),
    };
    dirty = true;
  }

  if (dirty) saveCache(projectRoot, cache);
}

function collectClientPackages(graph: ModuleGraph): Set<string> {
  const packages = new Set<string>();
  for (const path of graph.clientModules) {
    const mod = graph.modules.get(path);
    if (!mod) continue;
    for (const imp of mod.imports) {
      if (imp.packageName) packages.add(imp.packageName);
    }
  }
  return packages;
}

function measurePackageDir(projectRoot: string, packageName: string): number {
  const pkgDir = join(projectRoot, "node_modules", packageName);
  if (!existsSync(pkgDir)) return 0;

  // Prefer published dist / build / lib / esm directories when present
  for (const sub of ["dist", "build", "lib", "esm", "es"]) {
    const candidate = join(pkgDir, sub);
    if (existsSync(candidate)) {
      return du(candidate);
    }
  }
  return du(pkgDir);
}

function du(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        total += du(path);
      } else if (/\.(js|mjs|cjs|jsx|ts|tsx|json|wasm|css)$/i.test(entry.name)) {
        total += statSync(path).size;
      }
    }
  } catch {
    return total;
  }
  return total;
}

function resolveInstalledVersion(projectRoot: string, packageName: string): string | null {
  try {
    const require = createRequire(join(projectRoot, "package.json"));
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    const pkgJson = join(projectRoot, "node_modules", packageName, "package.json");
    if (!existsSync(pkgJson)) return null;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as { version?: string };
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }
}

function cachePath(projectRoot: string): string {
  return join(resolveOutputDir(projectRoot), "cache.json");
}

function loadCache(projectRoot: string): SizeCache {
  const path = cachePath(projectRoot);
  if (!existsSync(path)) return { packages: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SizeCache;
  } catch {
    return { packages: {} };
  }
}

function saveCache(projectRoot: string, cache: SizeCache): void {
  const dir = resolveOutputDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(projectRoot), JSON.stringify(cache, null, 2));
}
