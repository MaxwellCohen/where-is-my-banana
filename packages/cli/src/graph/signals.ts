import type { Program } from "oxc-parser";
import type { ClientSignals, Loc } from "../types.js";
import { locFromSpan } from "./loc.js";
import { type AstNode, stringLiteralValue, toAst, walkWithParent } from "./ast-walk.js";

const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
]);

const NODE_BUILTINS = new Set([
  "fs",
  "path",
  "crypto",
  "os",
  "child_process",
  "net",
  "tls",
  "dns",
  "stream",
  "buffer",
  "util",
  "http",
  "https",
  "zlib",
  "readline",
  "worker_threads",
]);

export function extractSignals(source: string, program: Program): ClientSignals {
  const signals: ClientSignals = {
    hooks: [],
    eventHandlers: [],
    browserGlobals: [],
    nodeBuiltins: [],
    envReads: [],
    jsxElements: 0,
    largestLiteralBytes: 0,
    components: [],
    useEffectCalls: [],
  };

  const lines = source.split("\n");

  for (const imp of program.body) {
    if (imp.type === "ImportDeclaration") {
      const spec = imp.source?.value ?? "";
      const base = spec.replace(/^node:/, "");
      if (NODE_BUILTINS.has(base)) {
        signals.nodeBuiltins.push(locFromSpan(imp, lines));
      }
    }
    if (imp.type === "VariableDeclaration") {
      for (const decl of imp.declarations) {
        if (decl.init?.type === "CallExpression") {
          const callee = decl.init.callee;
          if (callee.type === "Identifier" && callee.name === "require") {
            const arg = decl.init.arguments[0];
            const value = arg ? stringLiteralValue(toAst(arg as object)) : null;
            if (value) {
              const base = value.replace(/^node:/, "");
              if (NODE_BUILTINS.has(base)) {
                signals.nodeBuiltins.push(locFromSpan(decl, lines));
              }
            }
          }
        }
      }
    }
  }

  walkWithParent(toAst(program), (node, parent) => {
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      if (callee?.type === "Identifier") {
        const name = callee.name as string;
        if (/^use[A-Z]/.test(name) || name === "useEffect" || name === "useState") {
          signals.hooks.push(locFromSpan(node, lines));
        }
        const args = (node.arguments as AstNode[]) ?? [];
        if (name === "useEffect" && args[1]) {
          const deps = args[1];
          signals.useEffectCalls.push({
            loc: locFromSpan(node, lines),
            depsEmpty: deps.type === "ArrayExpression" && (deps.elements as unknown[]).length === 0,
          });
        }
      }
    }

    if (node.type === "MemberExpression") {
      const envName = getProcessEnvName(node);
      if (envName) {
        signals.envReads.push({ name: envName, loc: locFromSpan(node, lines) });
      }
      const obj = node.object as AstNode;
      if (
        obj?.type === "Identifier" &&
        BROWSER_GLOBALS.has(obj.name as string) &&
        !isTypeofGuard(node, parent)
      ) {
        signals.browserGlobals.push(locFromSpan(node, lines));
      }
    }

    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      signals.jsxElements++;
    }

    if (node.type === "JSXAttribute") {
      const name = node.name as AstNode;
      if (name?.type === "JSXIdentifier" && /^on[A-Z]/.test(name.name as string)) {
        signals.eventHandlers.push(locFromSpan(node, lines));
      }
    }

    if (node.type === "ObjectExpression" || node.type === "ArrayExpression") {
      const span = nodeSpan(node);
      if (span > signals.largestLiteralBytes) {
        signals.largestLiteralBytes = span;
      }
    }
  });

  extractComponents(program, signals, lines);
  return signals;
}

function extractComponents(program: Program, signals: ClientSignals, lines: string[]) {
  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration" && stmt.id?.name && /^[A-Z]/.test(stmt.id.name)) {
      const body = stmt.body;
      if (body?.type === "BlockStatement") {
        const start = locFromSpan(stmt, lines);
        const end = locFromSpan(stmt, lines, true);
        const count = countSignalsInRange(signals, start.line, end.endLine ?? start.line);
        signals.components.push({
          name: stmt.id.name,
          loc: start,
          endLoc: end,
          signals: count,
        });
      }
    }
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        if (
          decl.id.type === "Identifier" &&
          /^[A-Z]/.test(decl.id.name) &&
          (decl.init?.type === "ArrowFunctionExpression" || decl.init?.type === "FunctionExpression")
        ) {
          const start = locFromSpan(decl, lines);
          const end = locFromSpan(decl, lines, true);
          const count = countSignalsInRange(signals, start.line, end.endLine ?? start.line);
          signals.components.push({
            name: decl.id.name,
            loc: start,
            endLoc: end,
            signals: count,
          });
        }
      }
    }
  }
}

function countSignalsInRange(signals: ClientSignals, startLine: number, endLine: number): number {
  const inRange = (l: Loc) => l.line >= startLine && l.line <= endLine;
  return (
    signals.hooks.filter(inRange).length +
    signals.eventHandlers.filter(inRange).length +
    signals.browserGlobals.filter(inRange).length
  );
}

function isTypeofGuard(node: { type: string }, parent: { type: string } | null): boolean {
  return parent?.type === "UnaryExpression";
}

function getProcessEnvName(node: AstNode): string | null {
  const property = node.property as AstNode | undefined;
  const object = node.object as AstNode | undefined;
  if (
    property?.type === "Identifier" &&
    object?.type === "MemberExpression" &&
    (object.object as AstNode)?.type === "Identifier" &&
    (object.object as AstNode).name === "process" &&
    (object.property as AstNode)?.type === "Identifier" &&
    (object.property as AstNode).name === "env"
  ) {
    return property.name as string;
  }
  return null;
}

function nodeSpan(node: AstNode): number {
  const start = node.span?.start ?? node.start;
  const end = node.span?.end ?? node.end;
  if (start == null || end == null) return 0;
  return (end as number) - (start as number);
}
