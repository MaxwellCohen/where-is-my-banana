import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AuditContext, AuditReport, Check, CheckName, Finding, SourceFile } from "./types.js";
import { CHECKS } from "./types.js";
import { cmsImageParams, imageConfig, lcpPriority, rawImg } from "./images.js";
import { cssWeight, fonts } from "./fonts-css.js";
import { mapsWidgets, previewCodeInProd, thirdPartyScript } from "./scripts.js";
import { forceDynamic, fullCmsPayloadToClient, middlewareScope, missingStaticParams, sequentialAwait } from "./rendering.js";
import { heavyDeps, oldBrowserslist } from "./deps.js";
import { ssrFalseMisuse, useClientInventory } from "./client.js";
import { buildReport } from "./output.js";
import { makeIgnoreMatcher } from "./glob.js";
import { withScore } from "./score.js";
import { detectNextApps, filesOfApp } from "./workspace.js";
import { applyBaseline, type Baseline } from "./baseline.js";

export { CHECKS } from "./types.js";
export type { AuditReport, CheckName, Finding } from "./types.js";

export const CHECK_FNS: Record<CheckName, Check> = {
  "third-party-script": thirdPartyScript,
  "raw-img": rawImg,
  "lcp-priority": lcpPriority,
  "image-config": imageConfig,
  "cms-image-params": cmsImageParams,
  fonts,
  "force-dynamic": forceDynamic,
  "missing-static-params": missingStaticParams,
  "sequential-await": sequentialAwait,
  "full-cms-payload-to-client": fullCmsPayloadToClient,
  "heavy-deps": heavyDeps,
  "old-browserslist": oldBrowserslist,
  "maps-widgets": mapsWidgets,
  "middleware-scope": middlewareScope,
  "preview-code-in-prod": previewCodeInProd,
  "css-weight": cssWeight,
  "use-client-inventory": useClientInventory,
  "ssr-false-misuse": ssrFalseMisuse,
};

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".wimb", ".git", ".turbo", ".vercel", ".cache", ".output", "coverage", "storybook-static"]);
const READ_RE = /(?:\.(?:[cm]?[jt]sx?|css|scss)$)|(?:(?:^|\/)package\.json$)|(?:(?:^|\/)\.?browserslist(?:rc)?$)/;
const MAX_BYTES = 2_000_000;

export function walkProject(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (!READ_RE.test(rel)) continue;
        try {
          if (statSync(abs).size > MAX_BYTES) continue;
          out.push({ path: rel, content: readFileSync(abs, "utf-8") });
        } catch {
          /* unreadable */
        }
      }
    }
  };
  visit(root);
  return out;
}

export function buildContext(files: SourceFile[]): AuditContext {
  const packages: AuditContext["packages"] = [];
  for (const f of files) {
    if (!/(?:^|\/)package\.json$/.test(f.path)) continue;
    try {
      packages.push({ path: f.path, json: JSON.parse(f.content) });
    } catch {
      /* invalid package.json */
    }
  }
  return { files, packages };
}

/** Pure: run checks over an in-memory context. */
export function auditContext(ctx: AuditContext, checks: readonly CheckName[] = CHECKS): Finding[] {
  const lines = new Map(ctx.files.map((f) => [f.path, f.content.split("\n")]));
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const name of checks) {
    for (const f of CHECK_FNS[name](ctx)) {
      if (isIgnoredInline(lines.get(f.file), f)) continue;
      const key = `${f.id}|${f.file}|${f.line}|${f.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(withScore(f));
    }
  }
  return out;
}

function isIgnoredInline(lines: string[] | undefined, f: Finding): boolean {
  if (!lines || f.line < 2) return false;
  const m = lines[f.line - 2]?.match(/wimb-ignore-next-line\b([^\n*]*)/);
  if (!m) return false;
  const names = m[1].split(/[\s,]+/).filter(Boolean);
  return names.length === 0 || names.includes("all") || names.includes(f.check) || names.includes(f.id);
}

export interface AuditOptions {
  projectRoot: string;
  checks?: readonly CheckName[];
  ignoreFiles?: string[];
  ignoreRules?: string[];
  baseline?: Baseline;
}

/** Findings after config ignores, before any baseline. Monorepos audit each Next app package separately. */
export function collectFindings(opts: AuditOptions): { findings: Finding[]; packages?: string[] } {
  const files = walkProject(opts.projectRoot);
  const ctx = buildContext(files);
  const checks = opts.checks ?? CHECKS;
  const apps = detectNextApps(opts.projectRoot, ctx.packages);
  let findings: Finding[] = [];
  let packages: string[] | undefined;
  if (apps.length > 0) {
    packages = apps.map((a) => a.name);
    for (const app of apps) {
      const appFiles = filesOfApp(files, app, apps);
      for (const f of auditContext(buildContext(appFiles), checks)) findings.push({ ...f, package: app.name });
    }
  } else {
    findings = auditContext(ctx, checks);
  }
  const rules = new Set(opts.ignoreRules ?? []);
  const ignored = makeIgnoreMatcher(opts.ignoreFiles ?? []);
  findings = findings.filter((f) => !rules.has(f.check) && !rules.has(f.id) && !ignored(f.file));
  return { findings, packages };
}

export function runAudit(opts: AuditOptions): AuditReport {
  const { findings, packages } = collectFindings(opts);
  const split = opts.baseline ? applyBaseline(findings, opts.baseline) : { fresh: findings, baselined: 0 };
  const report = buildReport(opts.projectRoot, split.fresh);
  if (opts.baseline) report.baselined = split.baselined;
  if (packages) report.packages = packages;
  return report;
}
