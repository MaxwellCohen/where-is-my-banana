import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PackageInfo } from "../types.js";

export function loadPackageInfo(projectRoot: string): PackageInfo {
  const pkgPath = join(projectRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const installSizes = new Map<string, number>();
  const nodeModules = join(projectRoot, "node_modules");

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };

  for (const name of Object.keys(allDeps)) {
    installSizes.set(name, installSize(nodeModules, name));
  }

  return {
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
    installSizes,
    lockfileVersions: parseLockfile(projectRoot),
  };
}

function installSize(nodeModules: string, pkgName: string): number {
  const pkgDir = join(nodeModules, pkgName);
  if (!existsSync(pkgDir)) return 0;
  try {
    return du(pkgDir);
  } catch {
    return 0;
  }
}

function du(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      total += du(path);
    } else {
      total += statSync(path).size;
    }
  }
  return total;
}

function parseLockfile(projectRoot: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  const pnpmLock = join(projectRoot, "pnpm-lock.yaml");
  if (existsSync(pnpmLock)) {
    const content = readFileSync(pnpmLock, "utf-8");
    for (const m of content.matchAll(/\/(@?[^/@]+(?:\/[^/@]+)?)@([^:]+):/g)) {
      const [, name, version] = m;
      const list = versions.get(name) ?? [];
      if (!list.includes(version)) list.push(version);
      versions.set(name, list);
    }
  }
  return versions;
}

export function getPackageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split("/")[0];
}
