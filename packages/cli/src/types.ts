import type { Program } from "oxc-parser";

export type ModuleEnv = "server" | "client" | "shared";
export type Directive = "use client" | "use server" | "server-only" | "client-only";
export type Severity = "error" | "warning" | "info";
export type Confidence = "high" | "medium" | "low";

export interface Loc {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface Import {
  specifier: string;
  resolvedPath: string | null;
  packageName: string | null;
  namedSymbols: string[];
  isDynamic: boolean;
  isTypeOnly: boolean;
  loc: Loc;
}

export interface ExportInfo {
  name: string;
  loc: Loc;
  referencedBy: { modulePath: string; symbols: string[] }[];
  isAsync: boolean;
}

export interface ClientSignals {
  hooks: Loc[];
  eventHandlers: Loc[];
  browserGlobals: Loc[];
  nodeBuiltins: Loc[];
  envReads: { name: string; loc: Loc }[];
  jsxElements: number;
  largestLiteralBytes: number;
  components: { name: string; loc: Loc; endLoc: Loc; signals: number }[];
  useEffectCalls: { loc: Loc; depsEmpty: boolean }[];
}

export interface Module {
  filePath: string;
  env: ModuleEnv;
  isBoundary: boolean;
  directives: Set<Directive>;
  imports: Import[];
  exports: ExportInfo[];
  ast: () => Program;
  signals: ClientSignals;
  sourceBytes: number;
  subtreeBytes: number;
  importChainFromEntry: string[];
  dependents: string[];
}

export interface ModuleGraph {
  modules: Map<string, Module>;
  entries: string[];
  clientModules: Set<string>;
  serverModules: Set<string>;
  sharedModules: Set<string>;
}

export interface PackageInfo {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  installSizes: Map<string, number>;
  lockfileVersions: Map<string, string[]>;
}

export interface DataTables {
  heavyPackages: Set<string>;
  categoryMap: Record<string, string[]>;
  serverPackages: Set<string>;
  authCryptoPackages: Set<string>;
  devPackages: Set<string>;
  thirdPartyScripts: Set<string>;
  onDemandLibs: Set<string>;
  heavyComponents: Set<string>;
  barrelPackages: Set<string>;
  staticRenderers: Set<string>;
  wasmPackages: Set<string>;
  localePatterns: RegExp[];
}

export interface ParsedNextConfig {
  distDir: string;
  optimizePackageImports: string[];
  webpackFallbacks: string[];
  resolveAliases: string[];
}

export interface WimbConfig {
  thresholds: {
    subtreeBytesHigh: number;
    largeLiteralBytes: number;
    largeJsonBytes: number;
    heavyPackageBytes: number;
    middlewareSourceBytes: number;
    middlewarePackageBytes: number;
    routeBudgetBytes: number;
    interactiveLeafRatio: number;
    barrelReexportRatio: number;
    barrelMinReexports: number;
    iconMapMinEntries: number;
    inlineSvgMinCount: number;
    inlineSvgMinBytes: number;
    dynamicImportMinSubtree: number;
    dynamicMisuseMaxSubtree: number;
    clientSignalRatio: number;
    providerMinImports: number;
    providerMaxInstallSize: number;
    searchIndexMinBytes: number;
    base64MinBytes: number;
    rscPayloadMaxFields: number;
  };
  ignores: {
    files: string[];
    rules: string[];
  };
  severityOverrides: Record<string, Severity>;
}

export interface FixStrategy {
  name: string;
  steps: string[];
}

export interface Finding {
  id: string;
  ruleId: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  file: string;
  loc?: Loc;
  message: string;
  evidence: Record<string, unknown>;
  estimatedBytes?: number;
  fixStrategy: FixStrategy;
  source?: "wimb" | "e18e" | "knip";
}

export interface ByteAttribution {
  routes: Map<string, number>;
  modules: Map<string, number>;
}

export interface Rule {
  id: string;
  category: string;
  defaultSeverity: Severity;
  run: (ctx: RuleContext) => void;
}

export interface RuleContext {
  projectRoot: string;
  graph: ModuleGraph;
  config: WimbConfig;
  pkg: PackageInfo;
  data: DataTables;
  nextConfig: ParsedNextConfig | null;
  byteAttribution: ByteAttribution | null;
  report: (finding: Finding) => void;
}

export interface ScanReport {
  version: string;
  timestamp: string;
  projectRoot: string;
  mode: "source" | "build";
  findings: Finding[];
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byCategory: Record<string, number>;
    estimatedClientBytes: number;
  };
}
