import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesGlob } from "./glob.js";
import type { PackageInfo, SourceFile } from "./types.js";

export interface AuditPackage {
  name: string;
  /** Posix dir relative to the project root; "" is the root. */
  dir: string;
}

function pnpmGlobs(root: string): string[] {
  const p = join(root, "pnpm-workspace.yaml");
  if (!existsSync(p)) return [];
  const out: string[] = [];
  let inPackages = false;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?/);
      if (m) out.push(m[1]);
      else if (/^\S/.test(line) && line.trim()) inPackages = false;
    }
  }
  return out;
}

export function workspaceGlobs(root: string, rootJson: Record<string, any> | undefined): string[] {
  const ws = rootJson?.workspaces;
  const fromPkg: string[] = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  return [...pnpmGlobs(root), ...fromPkg].filter((g) => typeof g === "string");
}

const hasNext = (json: Record<string, any>) => !!(json.dependencies?.next ?? json.devDependencies?.next ?? json.peerDependencies?.next);
const dirOf = (p: string) => p.replace(/(?:^|\/)package\.json$/, "");

/** Workspace members (including the root) that depend on `next`; empty when not a workspace or no Next app. */
export function detectNextApps(root: string, packages: PackageInfo[]): AuditPackage[] {
  const rootPkg = packages.find((p) => p.path === "package.json");
  const globs = workspaceGlobs(root, rootPkg?.json);
  if (globs.length === 0) return [];
  const pos = globs.filter((g) => !g.startsWith("!"));
  const neg = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const apps: AuditPackage[] = [];
  for (const p of packages) {
    const dir = dirOf(p.path);
    const isRoot = dir === "";
    if (!isRoot && !(pos.some((g) => matchesGlob(dir, g.replace(/\/$/, ""))) && !neg.some((g) => matchesGlob(dir, g.replace(/\/$/, ""))))) continue;
    if (!hasNext(p.json)) continue;
    apps.push({ name: typeof p.json.name === "string" ? p.json.name : dir || "root", dir });
  }
  return apps;
}

/** Files belonging to an app: under its dir and not under a deeper workspace app. */
export function filesOfApp(files: SourceFile[], app: AuditPackage, apps: AuditPackage[]): SourceFile[] {
  const deeper = apps.filter((a) => a !== app && a.dir !== "" && (app.dir === "" || a.dir.startsWith(app.dir + "/")));
  return files.filter((f) => {
    const inApp = app.dir === "" || f.path.startsWith(app.dir + "/");
    return inApp && !deeper.some((a) => f.path.startsWith(a.dir + "/"));
  });
}
