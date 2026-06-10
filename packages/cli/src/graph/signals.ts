import type { Program } from "oxc-parser";
import type { ClientSignals, Loc } from "../types.js";

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
            if (arg?.type === "StringLiteral") {
              const base = arg.value.replace(/^node:/, "");
              if (NODE_BUILTINS.has(base)) {
                signals.nodeBuiltins.push(locFromSpan(decl, lines));
              }
            }
          }
        }
      }
    }
  }

  walk(program, (node, parent) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const name = node.callee.name;
      if (/^use[A-Z]/.test(name) || name === "useEffect" || name === "useState") {
        signals.hooks.push(locFromSpan(node, lines));
      }
      if (name === "useEffect" && node.arguments[1]) {
        const deps = node.arguments[1];
        signals.useEffectCalls.push({
          loc: locFromSpan(node, lines),
          depsEmpty:
            deps.type === "ArrayExpression" && deps.elements.length === 0,
        });
      }
    }

    if (node.type === "MemberExpression") {
      const envName = getProcessEnvName(node);
      if (envName) {
        signals.envReads.push({ name: envName, loc: locFromSpan(node, lines) });
      }
      if (
        node.object.type === "Identifier" &&
        BROWSER_GLOBALS.has(node.object.name) &&
        !isTypeofGuard(node, parent)
      ) {
        signals.browserGlobals.push(locFromSpan(node, lines));
      }
    }

    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      signals.jsxElements++;
    }

    if (node.type === "JSXAttribute" && node.name.type === "JSXIdentifier") {
      if (/^on[A-Z]/.test(node.name.name)) {
        signals.eventHandlers.push(locFromSpan(node, lines));
      }
    }

    if (node.type === "ObjectExpression" || node.type === "ArrayExpression") {
      const span = nodeSpan(node, lines);
      if (span > signals.largestLiteralBytes) {
        signals.largestLiteralBytes = span;
      }
    }
  });

  extractComponents(source, program, signals, lines);
  return signals;
}

function extractComponents(
  source: string,
  program: Program,
  signals: ClientSignals,
  lines: string[],
) {
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
  if (
    node.property?.type === "Identifier" &&
    node.object?.type === "MemberExpression" &&
    node.object.object?.type === "Identifier" &&
    node.object.object.name === "process" &&
    node.object.property?.type === "Identifier" &&
    node.object.property.name === "env"
  ) {
    return node.property.name as string;
  }
  return null;
}

function nodeOffset(node: { span?: { start: number; end: number }; start?: number; end?: number }, end = false): number {
  if (end) return node.span?.end ?? node.end ?? 0;
  return node.span?.start ?? node.start ?? 0;
}

function locFromSpan(node: { span?: { start: number; end: number }; start?: number; end?: number }, lines: string[], end = false): Loc {
  const offset = nodeOffset(node, end);
  let line = 1;
  let col = 1;
  let pos = 0;
  for (const l of lines) {
    const len = l.length + 1;
    if (pos + len > offset) {
      col = offset - pos + 1;
      break;
    }
    pos += len;
    line++;
  }
  return { line, column: col };
}

function nodeSpan(node: { span?: { start: number; end: number }; start?: number; end?: number }, _lines: string[]): number {
  const start = node.span?.start ?? node.start;
  const end = node.span?.end ?? node.end;
  if (start == null || end == null) return 0;
  return end - start;
}

type AstNode = { type: string; [key: string]: unknown };

function walk(node: AstNode, visitor: (n: AstNode, parent: AstNode | null) => void, parent: AstNode | null = null) {
  visitor(node, parent);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as AstNode, visitor, node);
        }
      }
    } else if ("type" in val) {
      walk(val as AstNode, visitor, node);
    }
  }
}
