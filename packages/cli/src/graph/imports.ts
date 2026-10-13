import type { Program } from "oxc-parser";
import type { ResolverFactory } from "oxc-resolver";
import type { Import } from "../types.js";
import { getPackageName } from "./package-info.js";
import { locFromSpan } from "./loc.js";
import {
  type AstNode,
  exportedName,
  stringLiteralValue,
  toAst,
  walk,
} from "./ast-walk.js";

export function extractImports(
  filePath: string,
  source: string,
  program: Program,
  projectRoot: string,
  resolver: ResolverFactory,
  resolveImport: (
    from: string,
    specifier: string,
    projectRoot: string,
    resolver: ResolverFactory,
  ) => string | null,
): Import[] {
  const imports: Import[] = [];
  const lines = source.split("\n");
  const dynamicSpecifiers = collectDynamicSpecifiers(program);

  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") {
      const specifier = stmt.source?.value ?? "";
      const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
      imports.push({
        specifier,
        resolvedPath: resolved,
        packageName: getPackageName(specifier),
        namedSymbols:
          stmt.specifiers?.map((s) => {
            if (s.type === "ImportDefaultSpecifier") return "default";
            if (s.type === "ImportNamespaceSpecifier") return "*";
            return s.local?.name ?? "";
          }) ?? [],
        isDynamic: false,
        isTypeOnly: stmt.importKind === "type",
        loc: locFromSpan(stmt, lines),
      });
    }
    if (stmt.type === "ExportAllDeclaration" && stmt.source) {
      const specifier = stmt.source.value;
      const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
      imports.push({
        specifier,
        resolvedPath: resolved,
        packageName: getPackageName(specifier),
        namedSymbols: ["*"],
        isDynamic: false,
        isTypeOnly: false,
        loc: locFromSpan(stmt, lines),
      });
    }
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
      const specifier = stmt.source.value;
      const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
      imports.push({
        specifier,
        resolvedPath: resolved,
        packageName: getPackageName(specifier),
        namedSymbols: stmt.specifiers?.map((s) => exportedName(toAst(s.exported))) ?? [],
        isDynamic: false,
        isTypeOnly: false,
        loc: locFromSpan(stmt, lines),
      });
    }
  }

  walk(toAst(program), (node) => {
    if (node.type !== "ImportExpression") return;
    const specifier = stringLiteralValue(node.source as AstNode | undefined);
    if (!specifier) return;
    const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
    imports.push({
      specifier,
      resolvedPath: resolved,
      packageName: getPackageName(specifier),
      namedSymbols: ["default"],
      isDynamic: true,
      isTypeOnly: false,
      loc: locFromSpan(node, lines),
    });
  });

  for (const imp of imports) {
    if (dynamicSpecifiers.has(imp.specifier)) {
      imp.isDynamic = true;
    }
  }

  return imports;
}

function collectDynamicSpecifiers(program: Program): Set<string> {
  const specifiers = new Set<string>();
  walk(toAst(program), (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as AstNode;
    if (!isNextDynamicCallee(callee)) return;
    for (const arg of (node.arguments as AstNode[]) ?? []) {
      const inner = findImportExpression(arg);
      if (!inner) continue;
      const value = stringLiteralValue(inner.source as AstNode);
      if (value) specifiers.add(value);
    }
  });
  return specifiers;
}

function isNextDynamicCallee(callee: AstNode): boolean {
  if (callee.type === "Identifier" && callee.name === "dynamic") return true;
  if (callee.type !== "MemberExpression") return false;
  const obj = callee.object as AstNode;
  const prop = callee.property as AstNode;
  if (obj.type === "Identifier" && obj.name === "dynamic") return true;
  if (prop.type !== "Identifier" || prop.name !== "dynamic") return false;
  if (obj.type === "Identifier" && obj.name === "nextDynamic") return true;
  return false;
}

function findImportExpression(node: AstNode): AstNode | null {
  if (node.type === "ImportExpression") return node;
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    const body = node.body as AstNode;
    if (body.type === "ImportExpression") return body;
    if (body.type === "BlockStatement") {
      for (const stmt of (body.body as AstNode[]) ?? []) {
        if (stmt.type === "ReturnStatement") {
          const arg = stmt.argument as AstNode | undefined;
          if (arg?.type === "ImportExpression") return arg;
        }
      }
    }
  }
  return null;
}
