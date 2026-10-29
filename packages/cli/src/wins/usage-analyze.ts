import { parseSync } from "oxc-parser";
import { dirname, posix } from "node:path";
import { type AstNode, toAst } from "../graph/ast-walk.js";
import { locFromOffset } from "../graph/loc.js";
import { extractDirectives } from "../graph/directives.js";
import { extractSignals } from "../graph/signals.js";
import { getPackageName } from "../graph/package-info.js";
import type { ClientSignals } from "../types.js";
import type { EdgeRef, UsageKind } from "./types.js";

export interface Binding {
  local: string;
  kind: "default" | "named" | "namespace";
  imported: string; // exported name ("default" for default)
}

export interface ImportUsage {
  usage: UsageKind;
  usageLoc?: { line: number; column: number };
  bindings: Binding[];
  specifier: string;
  originalImport: string;
  typeOnly: boolean;
  isClient: boolean;
  inSuspense: boolean;
  /** an unconditional reference exists inside a page/layout default export */
  isPageOrLayout: boolean;
  found: boolean;
  unused: boolean;
}

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const TYPE_ANCESTORS =
  /^TS(TypeAnnotation|TypeReference|TypeAliasDeclaration|InterfaceDeclaration|TypeQuery|TypeParameter)/;
const TRANSPARENT_METHODS = new Set(["map", "flatMap", "filter", "reduce", "find", "some", "every"]);
const TRANSPARENT_HOOKS = new Set(["useMemo", "useState", "useReducer", "useRef", "useSyncExternalStore"]);

const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "").replace(/\/index$/, "");

function matchesEdge(spec: string, importer: string, edge: EdgeRef): boolean {
  if (edge.packageName) {
    if (getPackageName(spec) === edge.packageName) return true;
    return false;
  }
  const target = stripExt(edge.imported);
  if (spec.startsWith(".")) {
    return stripExt(posix.normalize(posix.join(dirname(importer), spec))) === target;
  }
  // alias (@/, ~/, #): suffix match
  const tail = stripExt(spec.replace(/^[@~#]\/?/, ""));
  return tail.length > 0 && (target === tail || target.endsWith("/" + tail));
}

interface Ref {
  node: AstNode;
  ancestors: AstNode[];
  jsx: boolean;
}

function collectRefs(root: AstNode, names: Set<string>): Ref[] {
  const refs: Ref[] = [];
  const stack: AstNode[] = [];
  const visit = (node: AstNode) => {
    if (node.type === "ImportDeclaration") return;
    const parent = stack[stack.length - 1];
    const isId = node.type === "Identifier" || node.type === "JSXIdentifier";
    if (isId && names.has(node.name)) {
      let ok = true;
      if (parent) {
        if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ok = false;
        else if (parent.type === "JSXMemberExpression" && parent.property === node) ok = false;
        else if (parent.type === "JSXAttribute" || parent.type === "JSXClosingElement") ok = false;
        else if ((parent.type === "Property" || parent.type === "PropertyDefinition") && parent.key === node && !parent.shorthand && !parent.computed) ok = false;
      }
      if (ok && !stack.some((a) => TYPE_ANCESTORS.test(a.type))) {
        refs.push({ node, ancestors: [...stack], jsx: node.type === "JSXIdentifier" });
      }
    }
    stack.push(node);
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (!val || typeof val !== "object") continue;
      if (Array.isArray(val)) {
        for (const c of val) if (c && typeof c === "object" && "type" in c) visit(c as AstNode);
      } else if ("type" in val) visit(val as AstNode);
    }
    stack.pop();
  };
  visit(root);
  return refs;
}

const isHandlerAttr = (n: AstNode) =>
  n.type === "JSXAttribute" && n.name?.type === "JSXIdentifier" && /^on[A-Z]/.test(n.name.name);

/** Is this function (with ancestors above it) executed outside render and clearly a handler/callback? */
function deferredKind(fn: AstNode, parent: AstNode | undefined, grand: AstNode | undefined): "transparent" | "handler" | "other" {
  if (parent?.type === "CallExpression" && parent.arguments?.includes(fn)) {
    const callee = parent.callee;
    if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier" && TRANSPARENT_METHODS.has(callee.property.name)) return "transparent";
    if (callee?.type === "Identifier" && TRANSPARENT_HOOKS.has(callee.name)) return "transparent";
    return "handler"; // useEffect, useCallback, setTimeout, .then, addEventListener...
  }
  if (parent?.type === "JSXExpressionContainer" && grand && isHandlerAttr(grand)) return "handler";
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier" && /^(on|handle|set|toggle|open|close|submit)/i.test(parent.id.name)) return "handler";
  if (fn.type === "FunctionDeclaration" && /^(on|handle)/i.test(fn.id?.name ?? "")) return "handler";
  return "other";
}

function classifyRef(ref: Ref): UsageKind {
  const chain = [...ref.ancestors, ref.node];
  const fnIdx: number[] = [];
  chain.forEach((n, i) => {
    if (FN_TYPES.has(n.type)) fnIdx.push(i);
  });
  if (fnIdx.length === 0) return "always-rendered"; // module-level
  // inner (non-component) functions
  let start = fnIdx[0]!;
  let deferred: "handler" | "other" | null = null;
  for (const i of fnIdx.slice(1)) {
    const k = deferredKind(chain[i]!, chain[i - 1], chain[i - 2]);
    if (k === "transparent") continue;
    deferred = k;
    start = i;
    break;
  }
  if (deferred === "handler") return "event-handler-only";
  if (deferred === "other") return ref.jsx ? "unknown" : "event-handler-only";
  // within render scope: look for conditional wrappers between component fn and ref
  for (let i = chain.length - 2; i > start; i--) {
    const n = chain[i]!;
    const child = chain[i + 1]!;
    if (isHandlerAttr(n)) return "event-handler-only";
    if (n.type === "ConditionalExpression" && n.test !== child) return "conditional-render";
    if (n.type === "LogicalExpression" && n.right === child) return "conditional-render";
    if (n.type === "IfStatement" && n.test !== child) return "conditional-render";
    if (n.type === "SwitchCase" && n.test !== child) return "conditional-render";
  }
  return "always-rendered";
}

function jsxName(n: AstNode | undefined): string {
  if (!n) return "";
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return n.property?.name ?? "";
  return "";
}

function inSuspense(ref: Ref): boolean {
  return ref.ancestors.some((a) => a.type === "JSXElement" && jsxName(a.openingElement?.name) === "Suspense");
}

export function parseSource(file: string, source: string) {
  return parseSync(file, source, { sourceType: "module" });
}

/** Cheap structural facts about an (imported) local module. */
export function moduleFacts(file: string, source: string): {
  hasDefault: boolean;
  isClient: boolean;
  signals: ClientSignals;
} {
  const { program } = parseSource(file, source);
  let hasDefault = false;
  for (const s of program.body) {
    const n = toAst(s);
    if (n.type === "ExportDefaultDeclaration") hasDefault = true;
    if (n.type === "ExportNamedDeclaration") {
      for (const sp of n.specifiers ?? []) {
        if ((sp.exported?.name ?? sp.exported?.value) === "default") hasDefault = true;
      }
    }
  }
  return {
    hasDefault,
    isClient: extractDirectives(program).has("use client"),
    signals: extractSignals(source, program),
  };
}

export function analyzeImportUsage(importerPath: string, source: string, edge: EdgeRef): ImportUsage {
  const empty: ImportUsage = {
    usage: "unknown",
    bindings: [],
    specifier: "",
    originalImport: "",
    typeOnly: false,
    isClient: false,
    inSuspense: false,
    isPageOrLayout: false,
    found: false,
    unused: false,
  };
  let program;
  try {
    program = parseSource(importerPath, source).program;
  } catch {
    return empty;
  }
  const lines = source.split("\n");
  const isClient = extractDirectives(program).has("use client");
  const base = importerPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  const isPageOrLayout = base === "page" || base === "layout";

  let decl: AstNode | null = null;
  for (const s of program.body) {
    const n = toAst(s);
    if (n.type === "ImportDeclaration" && matchesEdge(n.source?.value ?? "", importerPath, edge)) {
      decl = n;
      break;
    }
  }
  if (!decl) return { ...empty, isClient, isPageOrLayout };

  const bindings: Binding[] = [];
  for (const sp of decl.specifiers ?? []) {
    if (sp.importKind === "type") continue;
    const local = sp.local?.name as string;
    if (sp.type === "ImportDefaultSpecifier") bindings.push({ local, kind: "default", imported: "default" });
    else if (sp.type === "ImportNamespaceSpecifier") bindings.push({ local, kind: "namespace", imported: "*" });
    else bindings.push({ local, kind: "named", imported: sp.imported?.name ?? sp.imported?.value ?? local });
  }
  const res: ImportUsage = {
    ...empty,
    found: true,
    isClient,
    isPageOrLayout,
    bindings,
    specifier: decl.source.value,
    originalImport: source.slice(decl.start, decl.end),
    typeOnly: decl.importKind === "type",
  };
  if (res.typeOnly) return res;

  if (bindings.length === 0) {
    // side-effect import: nothing to analyze
    return res;
  }

  const refs = collectRefs(toAst(program), new Set(bindings.map((b) => b.local)));
  if (refs.length === 0) {
    res.unused = true;
    return res;
  }
  const kinds = refs.map(classifyRef);
  if (kinds.includes("always-rendered")) res.usage = "always-rendered";
  else if (kinds.includes("unknown")) res.usage = "unknown";
  else if (kinds.includes("conditional-render")) res.usage = "conditional-render";
  else res.usage = "event-handler-only";
  const pickIdx = kinds.findIndex((k) => k === res.usage);
  const pick = refs[pickIdx >= 0 ? pickIdx : 0]!;
  const off = (pick.node.start ?? pick.node.span?.start ?? 0) as number;
  const loc = locFromOffset(off, lines);
  res.usageLoc = { line: loc.line, column: loc.column };
  res.inSuspense = refs.some(inSuspense);
  return res;
}
