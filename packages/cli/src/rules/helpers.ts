import { relative, resolve } from "node:path";
import type { RuleContext, Finding, Severity, Module, Loc } from "../types.js";
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
    site.file.startsWith("/") || site.file.includes(ctx.projectRoot)
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
  return ctx.config.ignores.files.some((p) => file.includes(p));
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
  if (filePath.startsWith("/")) return filePath;
  if (filePath.includes(ctx.projectRoot)) return filePath;
  return resolve(ctx.projectRoot, filePath);
}

function findDirectProjectImporter(
  ctx: RuleContext,
  targetPath: string,
): { file: string; loc?: Loc } | null {
  const targetAbs = toAbsolutePath(ctx, targetPath);
  for (const mod of ctx.graph.modules.values()) {
    if (!isProjectSource(ctx, mod.filePath)) continue;
    for (const imp of mod.imports) {
      if (!imp.resolvedPath) continue;
      if (imp.resolvedPath === targetAbs || targetAbs.startsWith(`${imp.resolvedPath}/`)) {
        return { file: mod.filePath, loc: imp.loc };
      }
      if (imp.packageName && packagePathMatches(targetAbs, imp.packageName)) {
        return { file: mod.filePath, loc: imp.loc };
      }
    }
  }
  return null;
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

export function fixSteps(...steps: string[]) {
  return { name: "remediation", steps };
}
