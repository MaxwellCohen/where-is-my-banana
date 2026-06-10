import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import { extractSignals } from "./signals.js";
import { extractDirectives } from "./directives.js";
import { extractImports } from "./imports.js";
import { locFromSpan } from "./loc.js";
import type { Module, ModuleGraph, ExportInfo } from "../types.js";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const APP_DIRS = ["app", "src/app", "pages", "src/pages", "middleware.ts", "src/middleware.ts"];

export async function buildGraph(projectRoot: string): Promise<ModuleGraph> {
  const resolver = new ResolverFactory({
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    conditionNames: ["import", "require", "node", "default"],
  });

  const entries = findEntries(projectRoot);
  const modules = new Map<string, Module>();
  const pending = [...entries];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    if (!existsSync(filePath)) continue;
    const ext = extname(filePath);
    if (!SOURCE_EXTS.has(ext) && !filePath.endsWith("middleware.ts")) continue;

    const source = readFileSync(filePath, "utf-8");
    const parsed = parseSync(filePath, source, { sourceType: "module" });
    const lines = source.split("\n");
    const directives = extractDirectives(parsed.program);
    const imports = extractImports(
      filePath,
      source,
      parsed.program,
      projectRoot,
      resolver,
      resolveImport,
    );
    const exports = extractExports(parsed.program, lines);
    const signals = extractSignals(source, parsed.program);
    const sourceBytes = statSync(filePath).size;

    const mod: Module = {
      filePath,
      env: "server",
      isBoundary: directives.has("use client"),
      directives,
      imports,
      exports,
      ast: () => parsed.program,
      signals,
      sourceBytes,
      subtreeBytes: 0,
      importChainFromEntry: [filePath],
      dependents: [],
    };

    modules.set(filePath, mod);

    for (const imp of imports) {
      if (imp.resolvedPath && !visited.has(imp.resolvedPath)) {
        pending.push(imp.resolvedPath);
      }
    }
  }

  buildDependents(modules);
  classifyBoundaries(modules, entries);
  computeSubtreeBytes(modules);
  computeImportChains(modules, entries);
  trackExportReferences(modules);

  const clientModules = new Set<string>();
  const serverModules = new Set<string>();
  const sharedModules = new Set<string>();

  for (const [path, mod] of modules) {
    if (mod.env === "client") clientModules.add(path);
    else if (mod.env === "shared") sharedModules.add(path);
    else serverModules.add(path);
  }

  return { modules, entries, clientModules, serverModules, sharedModules };
}

function findEntries(projectRoot: string): string[] {
  const entries: string[] = [];
  for (const dir of APP_DIRS) {
    const full = join(projectRoot, dir);
    if (!existsSync(full)) continue;
    if (statSync(full).isFile()) {
      entries.push(full);
      continue;
    }
    walkDir(full, entries);
  }
  return entries;
}

function walkDir(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkDir(path, out);
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      out.push(path);
    }
  }
}

function resolveImport(
  from: string,
  specifier: string,
  projectRoot: string,
  resolver: ResolverFactory,
): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const result = resolver.sync(dirname(from), specifier);
    if (result.path) return result.path;
    return null;
  }
  const result = resolver.sync(join(projectRoot, "node_modules", specifier.split("/")[0]), specifier);
  if (result.path) return result.path;
  const nmResult = resolver.sync(projectRoot, specifier);
  return nmResult.path ?? null;
}

function extractExports(
  program: ReturnType<typeof parseSync>["program"],
  lines: string[],
): ExportInfo[] {
  const exports: ExportInfo[] = [];
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.declaration?.type === "FunctionDeclaration" && stmt.declaration.id) {
        exports.push({
          name: stmt.declaration.id.name,
          loc: locFromSpan(stmt.declaration, lines),
          referencedBy: [],
          isAsync: stmt.declaration.async ?? false,
        });
      }
      if (stmt.declaration?.type === "VariableDeclaration") {
        for (const decl of stmt.declaration.declarations) {
          if (decl.id.type === "Identifier") {
            exports.push({
              name: decl.id.name,
              loc: locFromSpan(decl, lines),
              referencedBy: [],
              isAsync: false,
            });
          }
        }
      }
      for (const spec of stmt.specifiers ?? []) {
        const exported =
          spec.exported?.type === "Identifier"
            ? spec.exported.name
            : spec.exported?.type === "Literal"
              ? String(spec.exported.value)
              : "";
        const local = spec.local?.type === "Identifier" ? spec.local.name : "";
        exports.push({
          name: exported || local,
          loc: locFromSpan(spec, lines),
          referencedBy: [],
          isAsync: false,
        });
      }
    }
    if (stmt.type === "ExportDefaultDeclaration") {
      exports.push({
        name: "default",
        loc: locFromSpan(stmt, lines),
        referencedBy: [],
        isAsync: false,
      });
    }
    if (stmt.type === "FunctionDeclaration" && stmt.id) {
      exports.push({
        name: stmt.id.name,
        loc: locFromSpan(stmt, lines),
        referencedBy: [],
        isAsync: stmt.async ?? false,
      });
    }
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        if (decl.id.type === "Identifier") {
          exports.push({
            name: decl.id.name,
            loc: locFromSpan(decl, lines),
            referencedBy: [],
            isAsync: false,
          });
        }
      }
    }
  }
  if (sourceHasMetadata(program)) {
    exports.push({
      name: "metadata",
      loc: { line: 1, column: 1 },
      referencedBy: [],
      isAsync: false,
    });
    exports.push({
      name: "generateMetadata",
      loc: { line: 1, column: 1 },
      referencedBy: [],
      isAsync: false,
    });
  }
  return exports;
}

function sourceHasMetadata(program: ReturnType<typeof parseSync>["program"]): boolean {
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration") {
      for (const decl of stmt.declaration.declarations) {
        if (decl.id.type === "Identifier" && (decl.id.name === "metadata" || decl.id.name === "generateMetadata")) {
          return true;
        }
      }
    }
  }
  return false;
}

function buildDependents(modules: Map<string, Module>) {
  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      if (imp.resolvedPath && modules.has(imp.resolvedPath)) {
        modules.get(imp.resolvedPath)!.dependents.push(mod.filePath);
      }
    }
  }
}

function classifyBoundaries(modules: Map<string, Module>, entries: string[]) {
  const clientReachable = new Set<string>();
  const queue: string[] = [];

  for (const [path, mod] of modules) {
    if (mod.isBoundary || mod.directives.has("client-only")) {
      clientReachable.add(path);
      queue.push(path);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const mod = modules.get(current);
    if (!mod) continue;
    for (const imp of mod.imports) {
      if (imp.isDynamic) continue;
      if (imp.resolvedPath && !clientReachable.has(imp.resolvedPath)) {
        clientReachable.add(imp.resolvedPath);
        queue.push(imp.resolvedPath);
      }
    }
  }

  const entrySet = new Set(entries);
  for (const [path, mod] of modules) {
    if (clientReachable.has(path)) {
      mod.env = "client";
    } else if (mod.directives.has("server-only") || mod.directives.has("use server")) {
      mod.env = "server";
    } else if (entrySet.has(path) || isAppRoute(path)) {
      mod.env = "server";
    } else {
      const usedByClient = mod.dependents.some((d) => clientReachable.has(d));
      const usedByServer = mod.dependents.some((d) => !clientReachable.has(d));
      if (usedByClient && usedByServer) mod.env = "shared";
      else if (usedByClient) mod.env = "client";
      else mod.env = "server";
    }
  }
}

function isAppRoute(filePath: string): boolean {
  return /\/(page|layout|template|loading|error|not-found|route)\.(t|j)sx?$/.test(filePath);
}

function computeSubtreeBytes(modules: Map<string, Module>) {
  for (const mod of modules.values()) {
    const visited = new Set<string>();
    const stack = [mod.filePath];
    let total = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (visited.has(p)) continue;
      visited.add(p);
      const m = modules.get(p);
      if (!m) continue;
      total += m.sourceBytes;
      for (const imp of m.imports) {
        if (imp.resolvedPath) stack.push(imp.resolvedPath);
      }
    }
    mod.subtreeBytes = total;
  }
}

function computeImportChains(modules: Map<string, Module>, entries: string[]) {
  for (const mod of modules.values()) {
    const visited = new Set<string>();
    const queue: { path: string; chain: string[] }[] = entries.map((e) => ({ path: e, chain: [e] }));
    while (queue.length > 0) {
      const { path, chain } = queue.shift()!;
      if (path === mod.filePath) {
        mod.importChainFromEntry = chain;
        break;
      }
      if (visited.has(path)) continue;
      visited.add(path);
      const m = modules.get(path);
      if (!m) continue;
      for (const imp of m.imports) {
        if (imp.resolvedPath) {
          queue.push({ path: imp.resolvedPath, chain: [...chain, imp.resolvedPath] });
        }
      }
    }
  }
}

function trackExportReferences(modules: Map<string, Module>) {
  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      if (!imp.resolvedPath || !modules.has(imp.resolvedPath)) continue;
      const target = modules.get(imp.resolvedPath)!;
      for (const sym of imp.namedSymbols) {
        const exp = target.exports.find((e) => e.name === sym || sym === "*");
        if (exp) {
          exp.referencedBy.push({ modulePath: mod.filePath, symbols: imp.namedSymbols });
        }
      }
    }
  }
}

export function relPath(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath);
}

export function isClientOnlyPackage(
  packageName: string,
  data: { heavyPackages: Set<string>; heavyComponents: Set<string> },
): boolean {
  return data.heavyPackages.has(packageName) || data.heavyComponents.has(packageName);
}
