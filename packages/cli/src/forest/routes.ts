import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

const APP_ROOTS = ["app", "src/app"];
const PAGE_RE = /\/page\.(t|j)sx?$/;
const LAYOUT_NAMES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function findPageFiles(projectRoot: string): string[] {
  const pages: string[] = [];
  for (const root of APP_ROOTS) {
    const full = join(projectRoot, root);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    walkForPages(full, projectRoot, pages);
  }
  return pages.sort();
}

function walkForPages(dir: string, projectRoot: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkForPages(path, projectRoot, out);
    } else if (PAGE_RE.test(path)) {
      out.push(relative(projectRoot, path));
    }
  }
}

export function filePathToRoute(pageFile: string): string {
  let routePath = pageFile.replace(/\\/g, "/");
  for (const root of APP_ROOTS) {
    if (routePath.startsWith(`${root}/`)) {
      routePath = routePath.slice(root.length + 1);
      break;
    }
  }
  routePath = routePath.replace(/\/?page\.(t|j)sx?$/, "");
  if (!routePath) return "/";

  const segments = routePath.split("/").filter((segment) => {
    if (!segment) return false;
    if (segment.startsWith("(") && segment.endsWith(")")) return false;
    return true;
  });

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function resolveLayoutChain(pageFile: string, projectRoot: string): string[] {
  const absPage = resolve(projectRoot, pageFile);
  const appRoot = findAppRoot(absPage, projectRoot);
  if (!appRoot) return [];

  const layouts: string[] = [];
  let walkDir = dirname(absPage);

  while (walkDir.startsWith(appRoot)) {
    for (const name of LAYOUT_NAMES) {
      const candidate = join(walkDir, name);
      if (existsSync(candidate)) {
        const rel = relative(projectRoot, candidate);
        if (!layouts.includes(rel)) layouts.unshift(rel);
        break;
      }
    }
    if (walkDir === appRoot) break;
    walkDir = dirname(walkDir);
  }

  return layouts;
}

function findAppRoot(absPage: string, projectRoot: string): string | null {
  for (const root of APP_ROOTS) {
    const full = resolve(projectRoot, root);
    if (absPage.startsWith(full + "/") || dirname(absPage) === full) {
      return full;
    }
  }
  return null;
}

export function entryFilesForPage(pageFile: string, projectRoot: string): string[] {
  const layouts = resolveLayoutChain(pageFile, projectRoot);
  const entries = [...layouts];
  if (!entries.includes(pageFile)) entries.push(pageFile);
  return entries;
}

export function isSourceFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return SOURCE_EXTS.has(ext);
}
