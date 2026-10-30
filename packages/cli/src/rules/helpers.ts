import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { RuleContext, Finding, Severity, Module, Loc, ModuleGraph } from "../types.js";
import { relPath } from "../graph/builder.js";

export function reportFinding(
  ctx: RuleContext,
  partial: Omit<Finding, "severity"> & { defaultSeverity: Severity },
): void {
  const finding = makeFinding(ctx, partial);
  if (finding) ctx.report(finding);
}

export function makeFinding(
  ctx: RuleContext,
  partial: Omit<Finding, "severity"> & { defaultSeverity: Severity },
): Finding | null {
  const override = ctx.config.severityOverrides[partial.ruleId];
  const site = resolveReportSite(ctx, partial.file, partial.loc);
  if (!site) return null;
  const file =
    isAbsolute(site.file) || site.file.includes(ctx.projectRoot)
      ? relPath(ctx.projectRoot, site.file)
      : site.file;
  return {
    ...partial,
    severity: override ?? partial.defaultSeverity,
    file,
    loc: site.loc,
  };
}

export function clientModules(ctx: RuleContext): Module[] {
  return projectClientModulePaths(ctx)
    .map((p) => ctx.graph.modules.get(p)!)
    .filter(Boolean);
}

export function projectClientModulePaths(ctx: RuleContext): string[] {
  return [...ctx.graph.clientModules].filter((path) => isProjectSource(ctx, path));
}

export function isFrameworkPackage(ctx: RuleContext, packageName: string): boolean {
  return ctx.data.frameworkPackages.has(packageName);
}

export function isIgnored(ctx: RuleContext, ruleId: string, file: string): boolean {
  if (ctx.config.ignores.rules.includes(ruleId)) return true;
  const normFile = file.replace(/\\/g, "/");
  return ctx.config.ignores.files.some((p) => {
    const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!norm) return false;
    return `/${normFile}/`.includes(`/${norm}/`);
  });
}

export function isViteApp(ctx: RuleContext): boolean {
  const deps = { ...ctx.pkg.dependencies, ...ctx.pkg.devDependencies };
  return Boolean(deps.vite) && !deps.next;
}

export function isProjectSource(ctx: RuleContext, filePath: string): boolean {
  const abs = toAbsolutePath(ctx, filePath);
  if (abs.includes("/node_modules/") || abs.includes("\\node_modules\\")) return false;
  const rel = relative(ctx.projectRoot, abs);
  return !rel.startsWith("..");
}

export function resolveReportSite(
  ctx: RuleContext,
  filePath: string,
  loc?: Loc,
): { file: string; loc?: Loc } | null {
  if (isProjectSource(ctx, filePath)) {
    return { file: filePath, loc };
  }

  const directImporter = findDirectProjectImporter(ctx, filePath);
  if (directImporter) return directImporter;

  const mod = ctx.graph.modules.get(toAbsolutePath(ctx, filePath));
  if (mod) {
    const fromChain = importSiteFromChain(ctx, mod);
    if (fromChain) return fromChain;
  }

  return null;
}

function toAbsolutePath(ctx: RuleContext, filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  if (filePath.includes(ctx.projectRoot)) return filePath;
  return resolve(ctx.projectRoot, filePath);
}

interface ImporterSite {
  file: string;
  loc?: Loc;
}

interface ImporterIndex {
  byPath: Map<string, ImporterSite[]>;
  byPackage: Map<string, ImporterSite[]>;
}

const importerIndexCache = new WeakMap<ModuleGraph, ImporterIndex>();

function getImporterIndex(ctx: RuleContext): ImporterIndex {
  const cached = importerIndexCache.get(ctx.graph);
  if (cached) return cached;
  const byPath = new Map<string, ImporterSite[]>();
  const byPackage = new Map<string, ImporterSite[]>();
  const push = (m: Map<string, ImporterSite[]>, key: string, site: ImporterSite) => {
    const list = m.get(key);
    if (list) list.push(site);
    else m.set(key, [site]);
  };
  const mods = [...ctx.graph.modules.values()]
    .filter((m) => isProjectSource(ctx, m.filePath))
    .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  for (const mod of mods) {
    for (const imp of mod.imports) {
      const site = { file: mod.filePath, loc: imp.loc };
      if (imp.resolvedPath) push(byPath, imp.resolvedPath, site);
      if (imp.packageName) push(byPackage, imp.packageName, site);
    }
  }
  const index = { byPath, byPackage };
  importerIndexCache.set(ctx.graph, index);
  return index;
}

function packageNameFromPath(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const parts = norm.slice(idx + "/node_modules/".length).split("/");
  if (!parts[0]) return null;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

function findDirectProjectImporter(
  ctx: RuleContext,
  targetPath: string,
): { file: string; loc?: Loc } | null {
  const targetAbs = toAbsolutePath(ctx, targetPath);
  const index = getImporterIndex(ctx);
  const candidates: ImporterSite[] = [];
  for (let p = targetAbs, prev = ""; p !== prev; prev = p, p = dirname(p)) {
    const hit = index.byPath.get(p);
    if (hit) candidates.push(...hit);
  }
  const pkgName = packageNameFromPath(targetAbs);
  if (pkgName) {
    const hit = index.byPackage.get(pkgName);
    if (hit) candidates.push(...hit);
  }
  if (!candidates.length) return null;
  const chain = ctx.graph.modules.get(targetAbs)?.importChainFromEntry;
  if (chain) {
    const onChain = candidates.find((c) => chain.includes(c.file));
    if (onChain) return onChain;
  }
  return candidates[0]!;
}

function importSiteFromChain(ctx: RuleContext, mod: Module): { file: string; loc?: Loc } | null {
  for (let i = mod.importChainFromEntry.length - 2; i >= 0; i--) {
    const candidate = mod.importChainFromEntry[i]!;
    if (!isProjectSource(ctx, candidate)) continue;
    const candidateMod = ctx.graph.modules.get(candidate);
    if (!candidateMod) return { file: candidate };
    const imp = candidateMod.imports.find(
      (i) =>
        i.resolvedPath === mod.filePath ||
        (i.resolvedPath && mod.filePath.startsWith(`${i.resolvedPath}/`)) ||
        (i.packageName && packagePathMatches(mod.filePath, i.packageName)),
    );
    return { file: candidate, loc: imp?.loc };
  }
  return null;
}

function packagePathMatches(filePath: string, packageName: string): boolean {
  return (
    filePath.includes(`/node_modules/${packageName}/`) ||
    filePath.includes(`\\node_modules\\${packageName}\\`)
  );
}

export function packageInClientGraph(ctx: RuleContext, packageName: string): string[] {
  const files: string[] = [];
  for (const path of projectClientModulePaths(ctx)) {
    const mod = ctx.graph.modules.get(path)!;
    if (mod.imports.some((i) => i.packageName === packageName)) {
      files.push(relPath(ctx.projectRoot, path));
    }
  }
  return files;
}

export function getInstallSize(ctx: RuleContext, packageName: string): number {
  return ctx.pkg.installSizes.get(packageName) ?? 0;
}

export function estimatedBytes(ctx: RuleContext, packageName: string): number {
  if (ctx.byteAttribution?.modules.has(packageName)) {
    return ctx.byteAttribution.modules.get(packageName)!;
  }
  return getInstallSize(ctx, packageName);
}

/** True when package size came from next analyze attribution. */
export function isMeasuredPackageBytes(ctx: RuleContext, packageName: string): boolean {
  return Boolean(ctx.byteAttribution?.measured && ctx.byteAttribution.modules.has(packageName));
}

export function fixSteps(...steps: string[]) {
  return { name: "remediation", steps };
}
