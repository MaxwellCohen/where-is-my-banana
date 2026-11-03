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
  /** position of the import statement in the importer */
  importLoc?: { line: number; column: number };
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

function locOf(off: number, lines: string[]): { line: number; column: number } {
  const loc = locFromOffset(off, lines);
  return { line: loc.line, column: loc.column };
}

const offsetOf = (n: AstNode): number => (n.start ?? n.span?.start ?? 0) as number;
const endOf = (n: AstNode): number => (n.end ?? n.span?.end ?? 0) as number;

/** Line of the import/re-export statement in `source` that resolves to `edge.imported`. */
export function findImportLine(importerPath: string, source: string, edge: EdgeRef): { line: number; column: number } | undefined {
  try {
    const { program } = parseSource(importerPath, source);
    const lines = source.split("\n");
    for (const st of program.body) {
      const n = toAst(st);
      if (!n.source || !/^(Import|Export)/.test(n.type)) continue;
      if (matchesEdge(n.source.value ?? "", importerPath, edge)) return locOf(offsetOf(n), lines);
    }
  } catch {
    // unparsable
  }
  return undefined;
}

/** Barrel: a module whose body is mostly `export * from` / `export { x } from` re-exports. */
export function isBarrelSource(file: string, source: string): boolean {
  try {
    const { program } = parseSource(file, source);
    let reexports = 0;
    let other = 0;
    for (const st of program.body) {
      const n = toAst(st);
      if (n.type === "ImportDeclaration") continue;
      if (n.type === "ExpressionStatement" && n.directive) continue;
      if ((n.type === "ExportAllDeclaration" || n.type === "ExportNamedDeclaration") && n.source) reexports++;
      else other++;
    }
    return reexports >= 2 && reexports >= other * 1.5;
  } catch {
    return false;
  }
}

export interface DynamicUsage {
  found: boolean;
  /** wrapped in next/dynamic / React.lazy / lazy() bound to a variable */
  wrapped: boolean;
  ssrFalse: boolean;
  usage: UsageKind;
}

const LAZY_WRAPPERS = new Set(["dynamic", "lazy", "defineAsyncComponent"]);

/** How a dynamic `import('x')` that resolves to `edge.imported` is used inside `importerPath`. */
export function analyzeDynamicUsage(importerPath: string, source: string, edge: EdgeRef): DynamicUsage {
  const none: DynamicUsage = { found: false, wrapped: false, ssrFalse: false, usage: "unknown" };
  let program;
  try {
    program = parseSource(importerPath, source).program;
  } catch {
    return none;
  }
  let hit: { node: AstNode; ancestors: AstNode[] } | null = null;
  const stack: AstNode[] = [];
  const visit = (node: AstNode) => {
    if (hit) return;
    if (node.type === "ImportExpression" && typeof node.source?.value === "string" && matchesEdge(node.source.value, importerPath, edge)) {
      hit = { node, ancestors: [...stack] };
      return;
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
  visit(toAst(program));
  if (!hit) return none;
  const { ancestors } = hit as { node: AstNode; ancestors: AstNode[] };
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const call = ancestors[i]!;
    if (call.type !== "CallExpression") continue;
    const callee = call.callee;
    const name = callee?.type === "Identifier" ? callee.name : callee?.type === "MemberExpression" ? callee.property?.name : undefined;
    if (!name || !LAZY_WRAPPERS.has(name)) continue;
    const opts = call.arguments?.[1];
    const ssrFalse = !!opts?.properties?.some(
      (p: AstNode) => (p.key?.name ?? p.key?.value) === "ssr" && p.value?.type === "Literal" && p.value.value === false,
    );
    const decl = ancestors[i - 1];
    const local = decl?.type === "VariableDeclarator" && decl.id?.type === "Identifier" ? (decl.id.name as string) : null;
    if (!local) return { found: true, wrapped: true, ssrFalse, usage: "unknown" };
    const refs = collectRefs(toAst(program), new Set([local])).filter((r) => r.ancestors[r.ancestors.length - 1] !== decl);
    if (refs.length === 0) return { found: true, wrapped: true, ssrFalse, usage: "event-handler-only" };
    const kinds = refs.map(classifyRef);
    const usage: UsageKind = kinds.includes("always-rendered")
      ? "always-rendered"
      : kinds.includes("unknown")
        ? "unknown"
        : kinds.includes("conditional-render")
          ? "conditional-render"
          : "event-handler-only";
    return { found: true, wrapped: true, ssrFalse, usage };
  }
  return { found: true, wrapped: false, ssrFalse: false, usage: "event-handler-only" };
}

export interface GuardCandidate {
  binding: Binding;
  specifier: string;
  /** source of the first call, its callee and first argument */
  callSrc: string;
  calleeSrc: string;
  argSrc: string;
  fnName: string | null;
  fnAsync: boolean;
  loc: { line: number; column: number };
}

/**
 * A heavy library used only through calls inside plain (non-component, non-hook) functions:
 * the call site can be guarded by a cheap pre-check and the library imported on demand.
 */
export function findGuardCandidate(importerPath: string, source: string, edge: EdgeRef): GuardCandidate | null {
  let program;
  try {
    program = parseSource(importerPath, source).program;
  } catch {
    return null;
  }
  const lines = source.split("\n");
  let decl: AstNode | null = null;
  for (const st of program.body) {
    const n = toAst(st);
    if (n.type === "ImportDeclaration" && n.importKind !== "type" && matchesEdge(n.source?.value ?? "", importerPath, edge)) {
      decl = n;
      break;
    }
  }
  if (!decl) return null;
  const bindings: Binding[] = [];
  for (const sp of decl.specifiers ?? []) {
    if (sp.importKind === "type") continue;
    const local = sp.local?.name as string;
    if (sp.type === "ImportDefaultSpecifier") bindings.push({ local, kind: "default", imported: "default" });
    else if (sp.type === "ImportNamespaceSpecifier") bindings.push({ local, kind: "namespace", imported: "*" });
    else bindings.push({ local, kind: "named", imported: sp.imported?.name ?? sp.imported?.value ?? local });
  }
  if (bindings.length !== 1) return null;
  const refs = collectRefs(toAst(program), new Set([bindings[0]!.local]));
  if (refs.length === 0) return null;
  let first: GuardCandidate | null = null;
  for (const ref of refs) {
    if (ref.jsx) return null;
    const a = ref.ancestors;
    const parent = a[a.length - 1];
    let call: AstNode | undefined;
    if (parent?.type === "CallExpression" && parent.callee === ref.node) call = parent;
    else if (parent?.type === "MemberExpression" && parent.object === ref.node && a[a.length - 2]?.type === "CallExpression" && a[a.length - 2]!.callee === parent) call = a[a.length - 2];
    if (!call) return null;
    let fnIdx = -1;
    for (let i = a.length - 1; i >= 0; i--) if (FN_TYPES.has(a[i]!.type)) { fnIdx = i; break; }
    if (fnIdx < 0) return null; // module-level call: runs on load
    const fn = a[fnIdx]!;
    const above = a[fnIdx - 1];
    const fnName: string | null =
      fn.id?.name ?? (above?.type === "VariableDeclarator" && above.id?.type === "Identifier" ? above.id.name : null) ?? ((above?.type === "MethodDefinition" || above?.type === "Property") && above.key?.name) ?? null;
    const fnAsync = !!fn.async;
    if (fnName ? (/^[A-Z]/.test(fnName) || /^use[A-Z]/.test(fnName)) && !fnAsync : !fnAsync) return null; // component / hook / anonymous render-time callback
    if (!first) {
      first = {
        binding: bindings[0]!,
        specifier: decl.source.value,
        callSrc: source.slice(offsetOf(call), endOf(call)),
        calleeSrc: source.slice(offsetOf(call.callee), endOf(call.callee)),
        argSrc: call.arguments?.[0] ? source.slice(offsetOf(call.arguments[0]), endOf(call.arguments[0])) : "",
        fnName,
        fnAsync,
        loc: locOf(offsetOf(call), lines),
      };
    }
  }
  return first;
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
    importLoc: locOf(decl.start ?? decl.span?.start ?? 0, lines),
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
