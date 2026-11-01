import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import { extractSignals } from "./signals.js";
import { extractDirectives } from "./directives.js";
import { extractImports } from "./imports.js";
import { locFromSpan } from "./loc.js";
import { bfsReach } from "./reach.js";
import { exportedName, toAst } from "./ast-walk.js";
import type { Module, ModuleGraph, ExportInfo } from "../types.js";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const APP_DIRS = ["app", "src/app", "pages", "src/pages", "middleware.ts", "src/middleware.ts"];

function visitedKey(filePath: string): string {
  let key = filePath;
  try {
    key = realpathSync(filePath);
  } catch {
    // missing file: fall back to the raw path
  }
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function findTsconfig(projectRoot: string): string | null {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(projectRoot, name);
    if (existsSync(path)) return path;
  }
  return null;
}

export async function buildGraph(
  projectRoot: string,
): Promise<ModuleGraph & { warnings: string[] }> {
  const tsconfig = findTsconfig(projectRoot);
  const resolver = new ResolverFactory({
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    conditionNames: ["import", "require", "node", "default"],
    ...(tsconfig ? { tsconfig: { configFile: tsconfig, references: "auto" } } : {}),
  });

  const entries = findEntries(projectRoot);
  const modules = new Map<string, Module>();
  const pending = [...entries];
  const visited = new Set<string>();
  const warnings: string[] = [];

  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (!existsSync(filePath)) continue;
    const key = visitedKey(filePath);
    if (visited.has(key)) continue;
    visited.add(key);

    if (!SOURCE_EXTS.has(extname(filePath))) continue;

    const source = readFileSync(filePath, "utf-8");
    const parsed = parseSync(filePath, source, { sourceType: "module" });
    for (const err of parsed.errors ?? []) {
      warnings.push(`${relative(projectRoot, filePath)}: parse error: ${err.message}`);
    }
    const lines = source.split(/\r?\n/);
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
      if (imp.resolvedPath && !visited.has(visitedKey(imp.resolvedPath))) {
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

  return { modules, entries, clientModules, serverModules, sharedModules, warnings };
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
  const fromFile = resolver.resolveFileSync(from, specifier);
  if (fromFile.path) return fromFile.path;

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const result = resolver.sync(dirname(from), specifier);
    if (result.path) return result.path;
    return null;
  }
  const result = resolver.sync(
    join(projectRoot, "node_modules", ...specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1)),
    specifier,
  );
  if (result.path) return result.path;
  const nmResult = resolver.sync(projectRoot, specifier);
  return nmResult.path ?? null;
}

function extractExports(
  program: ReturnType<typeof parseSync>["program"],
  lines: string[],
): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const push = (name: string, node: object, isAsync = false) => {
    exports.push({ name, loc: locFromSpan(node, lines), referencedBy: [], isAsync });
  };
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration;
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        push(decl.id.name, decl, decl.async ?? false);
      } else if (decl?.type === "ClassDeclaration" && decl.id) {
        push(decl.id.name, decl);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type === "Identifier") push(d.id.name, d);
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
        push(exported || local, spec);
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      push("default", stmt);
    } else if (stmt.type === "ExportAllDeclaration") {
      const name = stmt.exported ? exportedName(toAst(stmt.exported)) : "";
      push(name || "*", stmt);
    }
  }
  return exports;
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
  const seeds: string[] = [];
  for (const [path, mod] of modules) {
    if (mod.isBoundary || mod.directives.has("client-only")) seeds.push(path);
  }
  const clientReachable = bfsReach(seeds, function* (path) {
    const mod = modules.get(path);
    if (!mod) return;
    for (const imp of mod.imports) {
      if (!imp.isDynamic && imp.resolvedPath) yield imp.resolvedPath;
    }
  });

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
  // Static edges only (skip dynamic / type-only), consistent with forest/builder.ts.
  const paths = [...modules.keys()];
  const n = paths.length;
  const index = new Map(paths.map((p, i) => [p, i]));
  const adj: number[][] = paths.map((p) => {
    const out: number[] = [];
    for (const imp of modules.get(p)!.imports) {
      if (imp.isDynamic || imp.isTypeOnly || !imp.resolvedPath) continue;
      const t = index.get(imp.resolvedPath);
      if (t !== undefined) out.push(t);
    }
    return out;
  });

  // Iterative Tarjan SCC; components are emitted dependencies-first.
  const idx = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const sccs: number[][] = [];
  const stack: number[] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (idx[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    idx[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame[0];
      if (frame[1] < adj[v]!.length) {
        const w = adj[v]![frame[1]++]!;
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, idx[w]!);
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]![0];
          low[parent] = Math.min(low[parent]!, low[v]!);
        }
        if (low[v] === idx[v]) {
          const members: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = sccs.length;
            members.push(w);
          } while (w !== v);
          sccs.push(members);
        }
      }
    }
  }

  if (sccs.length * ((n + 31) >>> 5) > 1 << 26) {
    // Bitsets would exceed ~256MB: fall back to a per-SCC DFS (O(n) memory).
    const seen = new Int32Array(n).fill(-1);
    for (let c = 0; c < sccs.length; c++) {
      let total = 0;
      const todo = [...sccs[c]!];
      for (const v of todo) seen[v] = c;
      while (todo.length > 0) {
        const v = todo.pop()!;
        total += modules.get(paths[v]!)!.sourceBytes;
        for (const w of adj[v]!) {
          if (seen[w] === c) continue;
          seen[w] = c;
          todo.push(w);
        }
      }
      for (const v of sccs[c]!) modules.get(paths[v]!)!.subtreeBytes = total;
    }
    return;
  }

  // Reachability bitset per SCC (exact, handles diamonds without double counting).
  const words = (n + 31) >>> 5;
  const bits: Uint32Array[] = [];
  const bytesOf = paths.map((p) => modules.get(p)!.sourceBytes);
  for (let c = 0; c < sccs.length; c++) {
    const set = new Uint32Array(words);
    for (const v of sccs[c]!) {
      set[v >>> 5]! |= 1 << (v & 31);
      for (const w of adj[v]!) {
        const cw = comp[w]!;
        if (cw === c) continue;
        const other = bits[cw]!;
        for (let k = 0; k < words; k++) set[k]! |= other[k]!;
      }
    }
    bits.push(set);
    let total = 0;
    for (let k = 0; k < words; k++) {
      let word = set[k]!;
      while (word !== 0) {
        const low1 = word & -word;
        total += bytesOf[(k << 5) + (31 - Math.clz32(low1))]!;
        word ^= low1;
      }
    }
    for (const v of sccs[c]!) modules.get(paths[v]!)!.subtreeBytes = total;
  }
}

function computeImportChains(modules: Map<string, Module>, entries: string[]) {
  // Single multi-source BFS with parent pointers; chains are rebuilt by walking parents.
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const e of entries) {
    if (modules.has(e) && !parent.has(e)) {
      parent.set(e, null);
      queue.push(e);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const path = queue[head]!;
    for (const imp of modules.get(path)!.imports) {
      const next = imp.resolvedPath;
      if (!next || parent.has(next) || !modules.has(next)) continue;
      parent.set(next, path);
      queue.push(next);
    }
  }
  for (const mod of modules.values()) {
    if (!parent.has(mod.filePath)) continue;
    const chain: string[] = [];
    for (let p: string | null | undefined = mod.filePath; p != null; p = parent.get(p)) chain.push(p);
    mod.importChainFromEntry = chain.reverse();
  }
}

function trackExportReferences(modules: Map<string, Module>) {
  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      if (!imp.resolvedPath || !modules.has(imp.resolvedPath)) continue;
      const target = modules.get(imp.resolvedPath)!;
      const wanted = new Set(imp.namedSymbols);
      const all = wanted.has("*");
      for (const exp of target.exports) {
        if (all || wanted.has(exp.name)) {
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
