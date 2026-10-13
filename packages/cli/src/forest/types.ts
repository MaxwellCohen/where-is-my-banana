import type { Directive, Loc } from "../types.js";

export type ForestRuntime = "server" | "client" | "both";

export interface ForestReport {
  version: string;
  timestamp: string;
  projectRoot: string;
  /** Entry files (layouts + pages) keyed by project-relative path — stored once */
  entries: Record<string, ForestEntry>;
  /** Module graph nodes keyed by project-relative path — stored once */
  modules: Record<string, ForestModule>;
  pages: ForestPage[];
}

export interface ForestPage {
  route: string;
  pageFile: string;
  layoutFiles: string[];
  /** Layout + page entry paths, in render order */
  entryFiles: string[];
  /** Entry files that seed the import walk for this route */
  roots: string[];
  /** All module files reachable from roots via static imports (deduped) */
  reachableFiles: string[];
  /** Files in this page's static graph that land in the client bundle */
  clientReachableFiles: string[];
  /** All imports affecting this route, sorted by subtreeBytes desc */
  imports: ForestPageImport[];
  /** Dynamic import edges reachable from this page's entries */
  lazyImports: ForestLazyImport[];
  /** Nested import tree merged from layout chain + page */
  forest: ForestNode;
  subtreeBytes: number;
  bundleBytes?: number;
}

export interface ForestEntry {
  file: string;
  role: "layout" | "page";
  runtime: ForestRuntime;
  isBoundary: boolean;
  directives: Directive[];
  sourceBytes: number;
  ast?: SerializableAst;
  defaultExport?: JsxTree | null;
}

export interface JsxTree {
  kind: "element" | "fragment" | "text" | "expression";
  name?: string;
  props?: Record<string, JsxPropValue>;
  children?: JsxTree[];
  loc?: Loc;
}

export type JsxPropValue =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "expression"; text: string }
  | { kind: "identifier"; name: string };

export interface ForestModule {
  file: string;
  runtime: ForestRuntime;
  isBoundary: boolean;
  directives: Directive[];
  sourceBytes: number;
  subtreeBytes: number;
  packageName: string | null;
  imports: ForestImportEdge[];
}

export interface ForestImportEdge {
  specifier: string;
  namedSymbols: string[];
  isDynamic: boolean;
  isTypeOnly: boolean;
  loc: Loc;
  resolvedFile: string | null;
  packageName: string | null;
  sourceBytes: number | null;
  subtreeBytes: number | null;
  bundleBytes?: number | null;
}

export type ForestLoadKind = "eager-static" | "lazy-dynamic" | "type-only";

export type ForestUsage =
  | { kind: "always" }
  | {
      kind: "conditional";
      componentName: string;
      branch: "consequent" | "alternate";
      pathRootCondition: boolean;
      routes?: string[];
      importerFile: string;
    };

export interface ForestPageImport {
  resolvedFile: string | null;
  specifier: string;
  namedSymbols: string[];
  loadKind: ForestLoadKind;
  usage: ForestUsage;
  runtime: ForestRuntime;
  isBoundary: boolean;
  directives: Directive[];
  importerFile: string;
  importChain: string[];
  sourceBytes: number | null;
  subtreeBytes: number | null;
  bundleBytes?: number | null;
  packageName: string | null;
  signals?: ForestSignalSummary;
  hints: ForestImportHint[];
}

export type ForestImportHint =
  | "branch-exclusive-eager"
  | "heavy-subtree"
  | "client-bundle"
  | "npm-heavy"
  | "lazy-already";

export interface ForestLazyImport {
  specifier: string;
  resolvedFile: string | null;
  importerFile: string;
  loc: Loc;
  sourceBytes: number | null;
  subtreeBytes: number | null;
  bundleBytes?: number | null;
}

export interface ForestSignalSummary {
  hooks: number;
  eventHandlers: number;
  browserGlobals: number;
  useEffectCalls: number;
  largestLiteralBytes: number;
}

export interface ForestNode {
  file: string;
  runtime: ForestRuntime;
  isBoundary: boolean;
  directives: Directive[];
  sourceBytes: number;
  subtreeBytes: number;
  packageName: string | null;
  imports: ForestImportNode[];
}

export interface ForestImportNode extends ForestImportEdge {
  loadKind: ForestLoadKind;
  usage: ForestUsage;
  hints: ForestImportHint[];
  child: ForestNode | null;
}

export interface SerializableAst {
  type: "Program";
  sourceType: "module" | "script";
  body: SerializableAstNode[];
  truncated?: boolean;
}

export interface SerializableAstNode {
  type: string;
  loc?: Loc;
  [key: string]: SerializableAstValue | Loc | undefined;
}

export type SerializableAstValue =
  | string
  | number
  | boolean
  | null
  | SerializableAstNode
  | SerializableAstNode[];
