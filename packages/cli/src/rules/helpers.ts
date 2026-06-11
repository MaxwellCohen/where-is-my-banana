import type { RuleContext, Finding, Severity, Module } from "../types.js";
import { relPath } from "../graph/builder.js";

export function makeFinding(
  ctx: RuleContext,
  partial: Omit<Finding, "severity"> & { defaultSeverity: Severity },
): Finding {
  const override = ctx.config.severityOverrides[partial.ruleId];
  const file = partial.file.startsWith("/") || partial.file.includes(ctx.projectRoot)
    ? relPath(ctx.projectRoot, partial.file)
    : partial.file;
  return {
    ...partial,
    severity: override ?? partial.defaultSeverity,
    file,
  };
}

export function clientModules(ctx: RuleContext): Module[] {
  return [...ctx.graph.clientModules]
    .map((p) => ctx.graph.modules.get(p)!)
    .filter(Boolean);
}

export function isFrameworkPackage(ctx: RuleContext, packageName: string): boolean {
  return ctx.data.frameworkPackages.has(packageName);
}

export function isIgnored(ctx: RuleContext, ruleId: string, file: string): boolean {
  if (ctx.config.ignores.rules.includes(ruleId)) return true;
  return ctx.config.ignores.files.some((p) => file.includes(p));
}

export function packageInClientGraph(ctx: RuleContext, packageName: string): string[] {
  const files: string[] = [];
  for (const path of ctx.graph.clientModules) {
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
