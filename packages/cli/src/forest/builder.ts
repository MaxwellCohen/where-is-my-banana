import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ByteAttribution, Import, Module, ModuleEnv, ModuleGraph } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { analyzeBranchExclusiveComponents } from "../analysis/branch-exclusive-components.js";
import type { BranchExclusiveCandidate } from "../analysis/branch-exclusive-components.js";
import { locFromSpan } from "../graph/loc.js";
import { resolveOutputDir } from "../paths.js";
import type {
  ForestEntry,
  ForestImportEdge,
  ForestImportHint,
  ForestImportNode,
  ForestLazyImport,
  ForestLoadKind,
  ForestModule,
  ForestNode,
  ForestPage,
  ForestPageImport,
  ForestReport,
  ForestRuntime,
  ForestSignalSummary,
  ForestUsage,
  JsxPropValue,
  JsxTree,
} from "./types.js";
import {
  entryFilesForPage,
  filePathToRoute,
  findPageFiles,
  resolveLayoutChain,
} from "./routes.js";
import { serializeAst, sliceSource } from "./serialize-ast.js";
import { type AstNode, toAst } from "../graph/ast-walk.js";

export interface ForestBuildOptions {
  compact?: boolean;
  /** Omit nested forest trees and global modules (large projects) */
  slim?: boolean;
  heavySubtreeThreshold?: number;
  /** Log page progress to stderr (used during scan) */
  verbose?: boolean;
}

/** Auto-omit AST when a project has many routes (AST dominates forest.json size/time). */
const AUTO_COMPACT_PAGE_THRESHOLD = 15;

/** Omit nested forest trees + global modules map (pages[].imports remains). */
const AUTO_SLIM_PAGE_THRESHOLD = 15;

const SLIM_MAX_IMPORTS_PER_PAGE = 500;

interface ReportContext {
  projectRoot: string;
  graph: ModuleGraph;
  byteAttribution: ByteAttribution | null;
  conditionalByImporter: Map<string, Map<string, BranchExclusiveCandidate>>;
  heavySubtreeThreshold: number;
  compact: boolean;
  slim: boolean;
  verbose: boolean;
  sourceCache: Map<string, string>;
}

interface PageContext extends ReportContext {
  entryFiles: string[];
  reachable: Set<string>;
  clientReachable: Set<string>;
  importChains: Map<string, string[]>;
}

export function moduleEnvToForestRuntime(env: ModuleEnv): ForestRuntime {
  if (env === "shared") return "both";
  return env;
}

export function buildForestReport(
  projectRoot: string,
  graph: ModuleGraph,
  byteAttribution?: ByteAttribution | null,
  options?: ForestBuildOptions,
): ForestReport {
  const entries = new Map<string, ForestEntry>();
  const modules = new Map<string, ForestModule>();
  const pages: ForestPage[] = [];
  const pageFiles = findPageFiles(projectRoot);
  const sourceCache = new Map<string, string>();
  const compact =
    options?.compact ??
    (pageFiles.length > AUTO_COMPACT_PAGE_THRESHOLD ? true : false);
  const slim =
    options?.slim ??
    (pageFiles.length > AUTO_SLIM_PAGE_THRESHOLD ? true : false);
  const verbose = options?.verbose ?? false;

  if (compact && options?.compact !== true && pageFiles.length > AUTO_COMPACT_PAGE_THRESHOLD) {
    console.log(
      `wimb: forest.json omitting AST (${pageFiles.length} pages — large project)`,
    );
  }
  if (slim && options?.slim !== true && pageFiles.length > AUTO_SLIM_PAGE_THRESHOLD) {
    console.log(
      `wimb: forest.json slim mode (${pageFiles.length} pages — nested trees and modules map omitted)`,
    );
  }

  const reportCtx: ReportContext = {
    projectRoot,
    graph,
    byteAttribution: byteAttribution ?? null,
    conditionalByImporter: buildGlobalConditionalUsageMap(projectRoot, graph, sourceCache),
    heavySubtreeThreshold:
      options?.heavySubtreeThreshold ?? DEFAULT_CONFIG.thresholds.dynamicImportMinSubtree,
    compact,
    slim,
    verbose,
    sourceCache,
  };

  for (let i = 0; i < pageFiles.length; i++) {
    const pageFile = pageFiles[i]!;
    if (verbose && (i === 0 || (i + 1) % 5 === 0 || i === pageFiles.length - 1)) {
      console.log(`wimb: forest ${i + 1}/${pageFiles.length} ${filePathToRoute(pageFile)}`);
    }
    pages.push(
      buildForestPage(pageFile, entries, modules, reportCtx, slim),
    );
  }

  return {
    version: "1.1.0",
    timestamp: new Date().toISOString(),
    projectRoot,
    entries: slim ? {} : Object.fromEntries(entries),
    modules: slim ? {} : Object.fromEntries(modules),
    pages,
  };
}

function stubForestNode(
  pageFile: string,
  graph: ModuleGraph,
  projectRoot: string,
): ForestNode {
  const abs = resolve(projectRoot, pageFile);
  const mod = graph.modules.get(abs);
  return {
    file: pageFile,
    runtime: mod ? moduleEnvToForestRuntime(mod.env) : "server",
    isBoundary: mod?.isBoundary ?? false,
    directives: mod ? [...mod.directives] : [],
    sourceBytes: mod?.sourceBytes ?? 0,
    subtreeBytes: mod?.subtreeBytes ?? 0,
    packageName: packageNameForModule(abs, projectRoot),
    imports: [],
  };
}

export function writeForestReport(
  projectRoot: string,
  graph: ModuleGraph,
  byteAttribution?: ByteAttribution | null,
  options?: ForestBuildOptions,
): ForestReport {
  const report = buildForestReport(projectRoot, graph, byteAttribution, options);
  const outputDir = resolveOutputDir(projectRoot);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "forest.json"), JSON.stringify(report));
  if (!byteAttribution) {
    console.log("wimb: run with --build for real client bundle sizes (bundleBytes)");
  }
  return report;
}

function buildForestPage(
  pageFile: string,
  entries: Map<string, ForestEntry>,
  modules: Map<string, ForestModule>,
  reportCtx: ReportContext,
  slim: boolean,
): ForestPage {
  const { projectRoot, graph, byteAttribution } = reportCtx;
  const route = filePathToRoute(pageFile);
  const layoutFiles = resolveLayoutChain(pageFile, projectRoot);
  const entryFiles = entryFilesForPage(pageFile, projectRoot);
  const reachable = new Set<string>();

  for (const file of entryFiles) {
    const role = file === pageFile ? "page" : "layout";
    if (!reportCtx.slim) {
      ensureForestEntry(file, projectRoot, graph, role, entries, reportCtx.compact);
    }
    walkModule(
      resolve(projectRoot, file),
      projectRoot,
      graph,
      modules,
      reachable,
      byteAttribution,
      !slim,
    );
  }

  const clientReachable = computeClientReachableFiles(projectRoot, graph, reachable);
  const importChains = buildImportChainIndex(entryFiles, reachable, projectRoot, graph);

  const ctx: PageContext = {
    ...reportCtx,
    entryFiles,
    reachable,
    clientReachable,
    importChains,
  };

  const forest = slim ? stubForestNode(pageFile, graph, projectRoot) : buildPageForest(ctx);
  const imports = buildPageImports(ctx);
  const lazyImports = buildLazyImports(ctx);

  const subtreeBytes = [...reachable].reduce((sum, rel) => {
    const abs = resolve(projectRoot, rel);
    const mod = graph.modules.get(abs);
    return sum + (mod?.sourceBytes ?? 0);
  }, 0);

  const page: ForestPage = {
    route,
    pageFile,
    layoutFiles,
    entryFiles,
    roots: entryFiles,
    reachableFiles: [...reachable].sort(),
    clientReachableFiles: [...clientReachable].sort(),
    imports,
    lazyImports,
    forest,
    subtreeBytes,
  };

  if (byteAttribution?.routes.has(route)) {
    page.bundleBytes = byteAttribution.routes.get(route);
  }

  return page;
}

function computeClientReachableFiles(
  projectRoot: string,
  graph: ModuleGraph,
  reachable: Set<string>,
): Set<string> {
  const clientReachable = new Set<string>();
  const queue: string[] = [];

  for (const rel of reachable) {
    const mod = graph.modules.get(resolve(projectRoot, rel));
    if (!mod) continue;
    if (mod.isBoundary || mod.directives.has("client-only")) {
      clientReachable.add(rel);
      queue.push(rel);
    }
  }

  while (queue.length > 0) {
    const rel = queue.shift()!;
    const mod = graph.modules.get(resolve(projectRoot, rel));
    if (!mod) continue;
    for (const imp of mod.imports) {
      if (imp.isDynamic || !imp.resolvedPath) continue;
      const childRel = relative(projectRoot, imp.resolvedPath);
      if (!reachable.has(childRel) || clientReachable.has(childRel)) continue;
      clientReachable.add(childRel);
      queue.push(childRel);
    }
  }

  return clientReachable;
}

function buildGlobalConditionalUsageMap(
  projectRoot: string,
  graph: ModuleGraph,
  sourceCache: Map<string, string>,
): Map<string, Map<string, BranchExclusiveCandidate>> {
  const byImporter = new Map<string, Map<string, BranchExclusiveCandidate>>();

  for (const path of graph.clientModules) {
    const rel = relative(projectRoot, path);
    if (rel.startsWith("..")) continue;

    const mod = graph.modules.get(path);
    if (!mod) continue;

    const source = getSource(path, sourceCache);
    const candidates = analyzeBranchExclusiveComponents(source, mod.ast(), mod.imports);
    if (candidates.length === 0) continue;

    const symbolMap = new Map<string, BranchExclusiveCandidate>();
    for (const c of candidates) {
      symbolMap.set(c.componentName, c);
    }
    byImporter.set(rel, symbolMap);
  }

  return byImporter;
}

function buildImportChainIndex(
  entryFiles: string[],
  reachable: Set<string>,
  projectRoot: string,
  graph: ModuleGraph,
): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  for (const entry of entryFiles) {
    chains.set(entry, [entry]);
  }

  const queue = [...entryFiles];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const chain = chains.get(file) ?? [file];
    const mod = graph.modules.get(resolve(projectRoot, file));
    if (!mod) continue;

    for (const imp of mod.imports) {
      if (!imp.resolvedPath || imp.isTypeOnly) continue;
      const childRel = relative(projectRoot, imp.resolvedPath);
      if (!reachable.has(childRel) || chains.has(childRel)) continue;
      chains.set(childRel, [...chain, childRel]);
      queue.push(childRel);
    }
  }

  return chains;
}

function buildPageForest(ctx: PageContext): ForestNode {
  const rootFile = ctx.entryFiles[0]!;
  const treeVisited = new Set<string>();
  const rootNode = buildForestNode(rootFile, ctx, treeVisited);

  const inTree = collectFilesInTree(rootNode);
  for (const entry of ctx.entryFiles.slice(1)) {
    if (inTree.has(entry)) continue;
    const entryNode = buildForestNode(entry, ctx, new Set<string>());
    rootNode.imports.push(createEntryLink(entry, entryNode, ctx));
  }

  return rootNode;
}

function createEntryLink(
  entryFile: string,
  child: ForestNode,
  ctx: PageContext,
): ForestImportNode {
  const abs = resolve(ctx.projectRoot, entryFile);
  const mod = ctx.graph.modules.get(abs);
  const edge = toImportEdge(
    {
      specifier: entryFile,
      resolvedPath: abs,
      packageName: null,
      namedSymbols: ["default"],
      isDynamic: false,
      isTypeOnly: false,
      loc: { line: 1, column: 0 },
    },
    ctx.projectRoot,
    ctx.graph,
    ctx.byteAttribution,
  );

  return enrichImportNode(edge, entryFile, entryFile, mod, ctx, null);
}

function buildForestNode(
  relFile: string,
  ctx: PageContext,
  visited: Set<string>,
): ForestNode {
  const abs = resolve(ctx.projectRoot, relFile);
  const mod = ctx.graph.modules.get(abs);

  const node: ForestNode = {
    file: relFile,
    runtime: mod ? moduleEnvToForestRuntime(mod.env) : "server",
    isBoundary: mod?.isBoundary ?? false,
    directives: mod ? [...mod.directives] : [],
    sourceBytes: mod?.sourceBytes ?? 0,
    subtreeBytes: mod?.subtreeBytes ?? 0,
    packageName: packageNameForModule(abs, ctx.projectRoot),
    imports: [],
  };

  if (!mod || visited.has(relFile)) return node;
  visited.add(relFile);

  for (const imp of mod.imports) {
    const edge = toImportEdge(imp, ctx.projectRoot, ctx.graph, ctx.byteAttribution);
    const resolvedRel = imp.resolvedPath ? relative(ctx.projectRoot, imp.resolvedPath) : null;
    const childMod = imp.resolvedPath ? ctx.graph.modules.get(imp.resolvedPath) : undefined;

    let child: ForestNode | null = null;
    if (!imp.isTypeOnly && !imp.isDynamic && resolvedRel && !visited.has(resolvedRel)) {
      child = buildForestNode(resolvedRel, ctx, visited);
    }

    node.imports.push(enrichImportNode(edge, relFile, resolvedRel, childMod, ctx, child));
  }

  return node;
}

function enrichImportNode(
  edge: ForestImportEdge,
  importerFile: string,
  resolvedFile: string | null,
  targetMod: Module | undefined,
  ctx: PageContext,
  child: ForestNode | null,
): ForestImportNode {
  const loadKind = loadKindForImport(edge);
  const usage = resolveUsage(importerFile, edge, ctx);
  const hints = buildHints(loadKind, usage, resolvedFile, edge, targetMod, ctx);

  return {
    ...edge,
    loadKind,
    usage,
    hints,
    child,
  };
}

function buildPageImports(ctx: PageContext): ForestPageImport[] {
  const byTarget = new Map<string, ForestPageImport>();

  for (const rel of ctx.reachable) {
    const abs = resolve(ctx.projectRoot, rel);
    const mod = ctx.graph.modules.get(abs);
    if (!mod) continue;

    for (const imp of mod.imports) {
      const edge = toImportEdge(imp, ctx.projectRoot, ctx.graph, ctx.byteAttribution);
      const loadKind = loadKindForImport(edge);
      const resolvedRel = imp.resolvedPath ? relative(ctx.projectRoot, imp.resolvedPath) : null;
      const targetKey = `${resolvedRel ?? edge.specifier}|${loadKind}`;

      const targetMod = imp.resolvedPath ? ctx.graph.modules.get(imp.resolvedPath) : undefined;
      const usage = resolveUsage(rel, edge, ctx);
      const hints = buildHints(loadKind, usage, resolvedRel, edge, targetMod, ctx);
      const runtime = targetMod
        ? moduleEnvToForestRuntime(targetMod.env)
        : resolvedRel && ctx.clientReachable.has(resolvedRel)
          ? "client"
          : "server";

      const row: ForestPageImport = {
        resolvedFile: resolvedRel,
        specifier: edge.specifier,
        namedSymbols: edge.namedSymbols,
        loadKind,
        usage,
        runtime,
        isBoundary: targetMod?.isBoundary ?? false,
        directives: targetMod ? [...targetMod.directives] : [],
        importerFile: rel,
        importChain: ctx.importChains.get(resolvedRel ?? rel) ?? [resolvedRel ?? rel],
        sourceBytes: edge.sourceBytes,
        subtreeBytes: edge.subtreeBytes,
        bundleBytes: edge.bundleBytes,
        packageName: edge.packageName,
        signals: ctx.slim ? undefined : targetMod ? signalSummary(targetMod) : undefined,
        hints,
      };

      const existing = byTarget.get(targetKey);
      if (!existing || (row.subtreeBytes ?? 0) > (existing.subtreeBytes ?? 0)) {
        byTarget.set(targetKey, row);
      }
    }
  }

  let rows = [...byTarget.values()].sort((a, b) => {
    const aBytes = a.subtreeBytes ?? -1;
    const bBytes = b.subtreeBytes ?? -1;
    return bBytes - aBytes;
  });

  if (ctx.slim && rows.length > SLIM_MAX_IMPORTS_PER_PAGE) {
    rows = rows.slice(0, SLIM_MAX_IMPORTS_PER_PAGE);
  }

  return rows;
}

function buildLazyImports(ctx: PageContext): ForestLazyImport[] {
  const lazy: ForestLazyImport[] = [];
  const seen = new Set<string>();

  for (const rel of ctx.reachable) {
    const abs = resolve(ctx.projectRoot, rel);
    const mod = ctx.graph.modules.get(abs);
    if (!mod) continue;

    for (const imp of mod.imports) {
      if (!imp.isDynamic) continue;
      const resolvedRel = imp.resolvedPath ? relative(ctx.projectRoot, imp.resolvedPath) : null;
      const key = `${rel}|${resolvedRel ?? imp.specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const targetMod = imp.resolvedPath ? ctx.graph.modules.get(imp.resolvedPath) : undefined;
      lazy.push({
        specifier: imp.specifier,
        resolvedFile: resolvedRel,
        importerFile: rel,
        loc: imp.loc,
        sourceBytes: targetMod?.sourceBytes ?? null,
        subtreeBytes: targetMod?.subtreeBytes ?? null,
        bundleBytes: imp.resolvedPath
          ? lookupBundleBytes(ctx.byteAttribution, imp.resolvedPath, ctx.projectRoot)
          : null,
      });
    }
  }

  return lazy.sort((a, b) => (b.subtreeBytes ?? -1) - (a.subtreeBytes ?? -1));
}

function resolveUsage(
  importerFile: string,
  edge: ForestImportEdge,
  ctx: PageContext,
): ForestUsage {
  const importerMap = ctx.conditionalByImporter.get(importerFile);
  if (!importerMap) return { kind: "always" };

  for (const symbol of edge.namedSymbols) {
    const candidate = importerMap.get(symbol);
    if (!candidate) continue;
    if (edge.isDynamic || edge.isTypeOnly) continue;

    return {
      kind: "conditional",
      componentName: candidate.componentName,
      branch: candidate.branch,
      pathRootCondition: candidate.pathRootCondition,
      routes: candidate.routes.length > 0 ? candidate.routes : undefined,
      importerFile,
    };
  }

  return { kind: "always" };
}

function loadKindForImport(edge: ForestImportEdge): ForestLoadKind {
  if (edge.isTypeOnly) return "type-only";
  if (edge.isDynamic) return "lazy-dynamic";
  return "eager-static";
}

function buildHints(
  loadKind: ForestLoadKind,
  usage: ForestUsage,
  resolvedFile: string | null,
  edge: ForestImportEdge,
  targetMod: Module | undefined,
  ctx: PageContext,
): ForestImportHint[] {
  const hints: ForestImportHint[] = [];
  const subtreeBytes = edge.subtreeBytes ?? 0;

  if (loadKind === "lazy-dynamic") hints.push("lazy-already");
  if (usage.kind === "conditional" && loadKind === "eager-static") {
    hints.push("branch-exclusive-eager");
  }
  if (subtreeBytes >= ctx.heavySubtreeThreshold) hints.push("heavy-subtree");
  if (resolvedFile && ctx.clientReachable.has(resolvedFile)) hints.push("client-bundle");
  if (edge.packageName && subtreeBytes >= ctx.heavySubtreeThreshold) hints.push("npm-heavy");

  return hints;
}

function signalSummary(mod: Module): ForestSignalSummary | undefined {
  if (mod.env !== "client" && mod.env !== "shared") return undefined;
  return {
    hooks: mod.signals.hooks.length,
    eventHandlers: mod.signals.eventHandlers.length,
    browserGlobals: mod.signals.browserGlobals.length,
    useEffectCalls: mod.signals.useEffectCalls.length,
    largestLiteralBytes: mod.signals.largestLiteralBytes,
  };
}

function collectFilesInTree(node: ForestNode): Set<string> {
  const files = new Set<string>([node.file]);
  for (const imp of node.imports) {
    if (imp.child) {
      for (const f of collectFilesInTree(imp.child)) files.add(f);
    } else if (imp.resolvedFile) {
      files.add(imp.resolvedFile);
    }
  }
  return files;
}

function getSource(absPath: string, sourceCache: Map<string, string>): string {
  const cached = sourceCache.get(absPath);
  if (cached !== undefined) return cached;
  const source = readFileSync(absPath, "utf-8");
  sourceCache.set(absPath, source);
  return source;
}

function ensureForestEntry(
  file: string,
  projectRoot: string,
  graph: ModuleGraph,
  role: "layout" | "page",
  entries: Map<string, ForestEntry>,
  compact: boolean,
): ForestEntry {
  const existing = entries.get(file);
  if (existing) return existing;

  const entry = buildForestEntry(file, projectRoot, graph, role, compact);
  entries.set(file, entry);
  return entry;
}

function walkModule(
  absPath: string,
  projectRoot: string,
  graph: ModuleGraph,
  modules: Map<string, ForestModule>,
  reachable: Set<string>,
  byteAttribution: ByteAttribution | null,
  collectModules = true,
): void {
  const rel = relative(projectRoot, absPath);
  reachable.add(rel);

  const mod = graph.modules.get(absPath);
  if (!mod) return;

  if (collectModules && !modules.has(rel)) {
    modules.set(rel, toForestModule(absPath, projectRoot, mod, graph, byteAttribution));
  }

  for (const imp of mod.imports) {
    if (imp.isTypeOnly || imp.isDynamic || !imp.resolvedPath) continue;
    if (reachable.has(relative(projectRoot, imp.resolvedPath))) continue;
    walkModule(
      imp.resolvedPath,
      projectRoot,
      graph,
      modules,
      reachable,
      byteAttribution,
      collectModules,
    );
  }
}

function toForestModule(
  absPath: string,
  projectRoot: string,
  mod: Module,
  graph: ModuleGraph,
  byteAttribution: ByteAttribution | null,
): ForestModule {
  return {
    file: relative(projectRoot, absPath),
    runtime: moduleEnvToForestRuntime(mod.env),
    isBoundary: mod.isBoundary,
    directives: [...mod.directives],
    sourceBytes: mod.sourceBytes,
    subtreeBytes: mod.subtreeBytes,
    packageName: packageNameForModule(absPath, projectRoot),
    imports: mod.imports.map((imp) => toImportEdge(imp, projectRoot, graph, byteAttribution)),
  };
}

function toImportEdge(
  imp: Import,
  projectRoot: string,
  graph: ModuleGraph,
  byteAttribution: ByteAttribution | null,
): ForestImportEdge {
  const resolvedAbs = imp.resolvedPath;
  const resolvedFile = resolvedAbs ? relative(projectRoot, resolvedAbs) : null;
  const childMod = resolvedAbs ? graph.modules.get(resolvedAbs) : undefined;

  return {
    specifier: imp.specifier,
    namedSymbols: imp.namedSymbols,
    isDynamic: imp.isDynamic,
    isTypeOnly: imp.isTypeOnly,
    loc: imp.loc,
    resolvedFile,
    packageName: imp.packageName,
    sourceBytes: childMod?.sourceBytes ?? null,
    subtreeBytes: childMod?.subtreeBytes ?? null,
    bundleBytes: resolvedAbs ? lookupBundleBytes(byteAttribution, resolvedAbs, projectRoot) : null,
  };
}

function buildForestEntry(
  file: string,
  projectRoot: string,
  graph: ModuleGraph,
  role: "layout" | "page",
  compact: boolean,
): ForestEntry {
  const absPath = resolve(projectRoot, file);
  const mod = graph.modules.get(absPath);
  const source = readFileSync(absPath, "utf-8");

  if (!mod) {
    const entry: ForestEntry = {
      file,
      role,
      runtime: "server",
      isBoundary: false,
      directives: [],
      sourceBytes: source.length,
    };
    if (!compact) {
      entry.ast = { type: "Program", sourceType: "module", body: [] };
      entry.defaultExport = null;
    }
    return entry;
  }

  const entry: ForestEntry = {
    file,
    role,
    runtime: moduleEnvToForestRuntime(mod.env),
    isBoundary: mod.isBoundary,
    directives: [...mod.directives],
    sourceBytes: mod.sourceBytes,
  };

  if (!compact) {
    const program = mod.ast();
    entry.ast = serializeAst(program, source);
    entry.defaultExport = extractDefaultExportJsx(program, source);
  }

  return entry;
}

function lookupBundleBytes(
  byteAttribution: ByteAttribution | null,
  absPath: string,
  projectRoot: string,
): number | null | undefined {
  if (!byteAttribution) return undefined;
  const rel = relative(projectRoot, absPath);
  return (
    byteAttribution.modules.get(absPath) ??
    byteAttribution.modules.get(rel) ??
    null
  );
}

function packageNameForModule(absPath: string, projectRoot: string): string | null {
  const rel = relative(projectRoot, absPath);
  if (!rel.startsWith("node_modules/")) return null;
  const parts = rel.split("/");
  if (parts[1]?.startsWith("@") && parts[2]) return `${parts[1]}/${parts[2]}`;
  return parts[1] ?? null;
}

function extractDefaultExportJsx(
  program: ReturnType<Module["ast"]>,
  source: string,
): JsxTree | null {
  const lines = source.split("\n");

  for (const stmt of program.body) {
    if (stmt.type === "ExportDefaultDeclaration") {
      return jsxFromNode(toAst(stmt.declaration as object), source, lines);
    }
  }

  return null;
}

function jsxFromNode(node: AstNode | null | undefined, source: string, lines: string[]): JsxTree | null {
  if (!node) return null;

  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    const body = node.body as AstNode | undefined;
    if (body?.type === "BlockStatement") {
      for (const stmt of (body.body as AstNode[]) ?? []) {
        if (stmt.type === "ReturnStatement") {
          return jsxFromNode(stmt.argument as AstNode, source, lines);
        }
      }
    }
    return null;
  }

  if (node.type === "ArrowFunctionExpression") {
    const body = node.body as AstNode;
    if (body.type === "JSXElement" || body.type === "JSXFragment") {
      return jsxFromNode(body, source, lines);
    }
    if (body.type === "BlockStatement") {
      for (const stmt of (body.body as AstNode[]) ?? []) {
        if (stmt.type === "ReturnStatement") {
          return jsxFromNode(stmt.argument as AstNode, source, lines);
        }
      }
    }
    return null;
  }

  if (node.type === "JSXFragment") {
    const children = ((node.children as AstNode[]) ?? [])
      .map((child) => jsxFromNode(child, source, lines))
      .filter((c): c is JsxTree => c != null);
    return {
      kind: "fragment",
      children,
      loc: nodeLoc(node, lines),
    };
  }

  if (node.type === "JSXElement") {
    const opening = node.openingElement as AstNode;
    const nameNode = opening.name as AstNode;
    const children = ((node.children as AstNode[]) ?? [])
      .map((child) => jsxFromNode(child, source, lines))
      .filter((c): c is JsxTree => c != null);

    return {
      kind: "element",
      name: jsxElementName(nameNode),
      props: jsxProps(opening.attributes as AstNode[], source, lines),
      children,
      loc: nodeLoc(node, lines),
    };
  }

  if (node.type === "JSXText") {
    const value = String(node.value ?? "").trim();
    if (!value) return null;
    return { kind: "text", name: value, loc: nodeLoc(node, lines) };
  }

  if (node.type === "JSXExpressionContainer") {
    const expr = node.expression as AstNode;
    if (expr?.type === "JSXEmptyExpression") return null;
    const loc = nodeLoc(node, lines);
    return {
      kind: "expression",
      name: loc ? sliceSource(source, loc) : undefined,
      loc,
    };
  }

  return null;
}

function jsxElementName(node: AstNode): string {
  if (node.type === "JSXIdentifier") return String(node.name);
  if (node.type === "JSXMemberExpression") {
    const obj = jsxElementName(node.object as AstNode);
    const prop = jsxElementName(node.property as AstNode);
    return `${obj}.${prop}`;
  }
  return "unknown";
}

function jsxProps(
  attributes: AstNode[],
  source: string,
  lines: string[],
): Record<string, JsxPropValue> {
  const props: Record<string, JsxPropValue> = {};
  for (const attr of attributes) {
    if (attr.type !== "JSXAttribute") continue;
    const nameNode = attr.name as AstNode;
    const key =
      nameNode.type === "JSXIdentifier"
        ? String(nameNode.name)
        : nameNode.type === "JSXNamespacedName"
          ? `${nameNode.namespace}.${nameNode.name}`
          : "unknown";
    const valueNode = attr.value as AstNode | null | undefined;
    if (!valueNode) {
      props[key] = { kind: "literal", value: true };
      continue;
    }
    if (valueNode.type === "StringLiteral" || valueNode.type === "Literal") {
      props[key] = { kind: "literal", value: valueNode.value as string | number | boolean | null };
      continue;
    }
    if (valueNode.type === "JSXExpressionContainer") {
      const expr = valueNode.expression as AstNode;
      if (expr?.type === "Identifier") {
        props[key] = { kind: "identifier", name: String(expr.name) };
      } else {
        const loc = nodeLoc(valueNode, lines);
        props[key] = {
          kind: "expression",
          text: loc ? sliceSource(source, loc) : "",
        };
      }
    }
  }
  return props;
}

function nodeLoc(node: AstNode, lines: string[]) {
  try {
    return locFromSpan(node, lines);
  } catch {
    return undefined;
  }
}
