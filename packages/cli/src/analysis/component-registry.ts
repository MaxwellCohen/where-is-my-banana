import type { Program } from "oxc-parser";
import type { Import, Loc } from "../types.js";
import { locFromSpan } from "../graph/loc.js";

type AstNode = { type: string; [key: string]: unknown };

export interface ComponentRegistry {
  exportName: string;
  loc: Loc;
  entryCount: number;
  componentEntryCount: number;
  importedComponentCount: number;
  referencedImportPaths: string[];
}

export interface ComponentRegistryOptions {
  literalDominanceRatio?: number;
}

const DEFAULT_LITERAL_DOMINANCE_RATIO = 0.8;

export function analyzeComponentRegistries(
  source: string,
  program: Program,
  imports: Import[],
  options: ComponentRegistryOptions = {},
): ComponentRegistry[] {
  const literalDominanceRatio =
    options.literalDominanceRatio ?? DEFAULT_LITERAL_DOMINANCE_RATIO;
  const lines = source.split("\n");
  const importedSymbols = buildImportedSymbolMap(program, imports);
  const localObjects = collectLocalObjectDeclarations(program, lines);
  const exportedNames = collectExportedNames(program);
  const registries: ComponentRegistry[] = [];

  for (const exportName of exportedNames) {
    const decl = localObjects.get(exportName);
    if (!decl || decl.init?.type !== "ObjectExpression") continue;

    const stats = analyzeObjectExpression(decl.init as AstNode, importedSymbols);
    if (stats.literalRatio > literalDominanceRatio) continue;
    if (stats.componentEntryCount === 0) continue;

    registries.push({
      exportName,
      loc: decl.loc,
      entryCount: stats.entryCount,
      componentEntryCount: stats.componentEntryCount,
      importedComponentCount: stats.importedComponentCount,
      referencedImportPaths: [...stats.referencedPaths],
    });
  }

  return registries;
}

interface ObjectStats {
  entryCount: number;
  componentEntryCount: number;
  importedComponentCount: number;
  literalCount: number;
  literalRatio: number;
  referencedPaths: Set<string>;
}

function analyzeObjectExpression(
  obj: AstNode,
  importedSymbols: Map<string, string | null>,
): ObjectStats {
  const properties = (obj.properties as AstNode[]) ?? [];
  const stats: ObjectStats = {
    entryCount: 0,
    componentEntryCount: 0,
    importedComponentCount: 0,
    literalCount: 0,
    literalRatio: 0,
    referencedPaths: new Set(),
  };

  for (const prop of properties) {
    if (prop.type === "SpreadElement") continue;
    if (prop.type !== "Property") continue;

    stats.entryCount++;
    const value = prop.value as AstNode;
    const key = prop.key as AstNode;
    const keyName = key.type === "Identifier" ? (key.name as string) : null;

    if (isLiteralValue(value)) {
      stats.literalCount++;
      continue;
    }

    if (!isComponentEntry(prop, value)) continue;

    stats.componentEntryCount++;

    const symbol = resolveComponentSymbol(prop, value, keyName);
    if (symbol && importedSymbols.has(symbol)) {
      stats.importedComponentCount++;
      const path = importedSymbols.get(symbol);
      if (path) stats.referencedPaths.add(path);
    }
  }

  stats.literalRatio = stats.entryCount > 0 ? stats.literalCount / stats.entryCount : 0;
  return stats;
}

function isLiteralValue(value: AstNode): boolean {
  return value.type === "Literal" || value.type === "StringLiteral" || value.type === "NumericLiteral";
}

function isComponentEntry(prop: AstNode, value: AstNode): boolean {
  if (value.type === "Identifier") return true;
  if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") {
    return containsJsx(value);
  }
  if (prop.method === true && (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression")) {
    return containsJsx(value);
  }
  return false;
}

function resolveComponentSymbol(prop: AstNode, value: AstNode, keyName: string | null): string | null {
  if (value.type === "Identifier") return value.name as string;
  if (prop.shorthand === true && keyName) return keyName;
  return null;
}

function containsJsx(node: AstNode): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (n.type === "JSXElement" || n.type === "JSXFragment") {
      found = true;
    }
  });
  return found;
}

function collectLocalObjectDeclarations(
  program: Program,
  lines: string[],
): Map<string, { init: AstNode | null; loc: Loc }> {
  const locals = new Map<string, { init: AstNode | null; loc: Loc }>();

  const record = (name: string, init: AstNode | null, loc: Loc) => {
    locals.set(name, { init, loc });
  };

  for (const stmt of program.body) {
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        if (decl.id.type === "Identifier") {
          record(decl.id.name, (decl.init as AstNode) ?? null, locFromSpan(decl, lines));
        }
      }
    }
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration") {
      for (const decl of stmt.declaration.declarations) {
        if (decl.id.type === "Identifier") {
          record(decl.id.name, (decl.init as AstNode) ?? null, locFromSpan(decl, lines));
        }
      }
    }
  }

  return locals;
}

function collectExportedNames(program: Program): Set<string> {
  const names = new Set<string>();

  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.declaration?.type === "VariableDeclaration") {
        for (const decl of stmt.declaration.declarations) {
          if (decl.id.type === "Identifier") names.add(decl.id.name);
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
        names.add(exported || local);
      }
    }
    if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.declaration;
      if (decl?.type === "Identifier") names.add(decl.name);
      if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type === "Identifier") names.add(d.id.name);
        }
      }
    }
  }

  return names;
}

function buildImportedSymbolMap(program: Program, imports: Import[]): Map<string, string | null> {
  const bySpecifier = new Map<string, Import[]>();
  for (const imp of imports) {
    if (imp.isDynamic || imp.isTypeOnly) continue;
    const list = bySpecifier.get(imp.specifier) ?? [];
    list.push(imp);
    bySpecifier.set(imp.specifier, list);
  }

  const map = new Map<string, string | null>();

  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const specifier = stmt.source?.value ?? "";
    const candidates = bySpecifier.get(specifier);
    const imp = candidates?.shift();
    const resolvedPath = imp?.resolvedPath ?? null;

    for (const spec of stmt.specifiers ?? []) {
      if (spec.type === "ImportDefaultSpecifier" && spec.local?.type === "Identifier") {
        map.set(spec.local.name, resolvedPath);
      }
      if (spec.type === "ImportSpecifier" && spec.local?.type === "Identifier") {
        map.set(spec.local.name, resolvedPath);
      }
    }
  }

  return map;
}

function walk(node: AstNode, visitor: (n: AstNode) => void): void {
  visitor(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as AstNode, visitor);
        }
      }
    } else if ("type" in val) {
      walk(val as AstNode, visitor);
    }
  }
}
