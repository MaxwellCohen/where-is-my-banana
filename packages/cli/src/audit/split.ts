import { parseSync } from "oxc-parser";
import { basename, dirname, extname } from "node:path";
import type { AuditContext, Finding, Severity, SplitCluster, SplitEvidence, SplitThresholds } from "./types.js";
import { HEAVY } from "./deps.js";
import { importsOf, isClient, isCode, resolveImport } from "./util.js";

export const DEFAULT_SPLIT: SplitThresholds = {
  splitMinLoc: 250,
  splitMinClusterLoc: 25,
  splitGodFileLoc: 600,
  splitGodFileDecls: 12,
  splitGodFileImports: 25,
  splitServerEligibleLoc: 80,
  splitRegistryMinImports: 8,
  splitHeavyKb: 30,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { type: string; [k: string]: any };

const HEAVY_LIB =
  /^(?:recharts|chart\.js|react-chartjs-2|d3(?:-[\w-]+)?|victory(?:-[\w-]+)?|@visx\/[\w-]+|@nivo\/[\w-]+|highcharts(?:-react-official)?|apexcharts|react-apexcharts|echarts(?:-for-react)?|plotly\.js[\w-]*|react-plotly\.js|three|@react-three\/[\w-]+|mapbox-gl|react-map-gl|maplibre-gl|leaflet|react-leaflet|@react-google-maps\/api|@googlemaps\/[\w-]+|google-map-react|@tiptap\/[\w-]+|slate(?:-react)?|quill|react-quill|lexical|@lexical\/[\w-]+|monaco-editor|@monaco-editor\/react|codemirror|@codemirror\/[\w-]+|ace-builds|react-ace|luxon|react-datepicker|react-day-picker|@fullcalendar\/[\w-]+|react-big-calendar|react-markdown|marked|markdown-it|remark(?:-[\w-]+)?|rehype(?:-[\w-]+)?|highlight\.js|prismjs|react-syntax-highlighter|shiki|pdfjs-dist|react-pdf|@react-pdf\/renderer|xlsx|exceljs|jspdf|html2canvas|lottie-web|lottie-react|react-player|video\.js|hls\.js|swiper|react-slick|embla-carousel(?:-[\w-]+)?)$/;

/** Packages that are safe to use inside a Server Component, so they do not pin a decl to the client. */
const SERVER_SAFE = /^(?:react|next\/(?:link|image|script|headers|navigation)|clsx|classnames|tailwind-merge|class-variance-authority|lucide-react|@heroicons\/react(?:\/.+)?|date-fns|@portabletext\/react|@contentful\/rich-text-[\w-]+|next-intl\/server)$/;

const BROWSER = new Set(["window", "document", "localStorage", "sessionStorage", "navigator", "IntersectionObserver", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "matchMedia", "alert", "confirm"]);
const TS_VALUE_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression"]);
const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "parent"]);

export function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#") || spec.startsWith("node:")) return null;
  const p = spec.split("/");
  return spec.startsWith("@") ? p.slice(0, 2).join("/") : p[0];
}

export interface Decl {
  names: string[];
  kind: "component" | "function" | "class" | "value";
  startLine: number;
  loc: number;
  exported: boolean;
  /** Value references (imports and other top-level names). */
  refs: Set<string>;
  /** Any identifier mention including type positions. */
  trefs: Set<string>;
  hooks: number;
  handlers: number;
  browser: boolean;
  jsx: number;
  /** Literal constant that can be copied rather than shared. */
  dup: boolean;
  /** Renders/behaves client-side (hooks, event handlers, browser APIs, class component). */
  interactive: boolean;
}

export interface Analysis {
  loc: number;
  client: boolean;
  decls: Decl[];
  imports: { local: string; pkg: string | null; spec: string }[];
  importCount: number;
  packages: string[];
  exports: number;
  hooks: number;
  jsx: number;
  typeNames: Set<string>;
  firstLine: number;
  /** relative-import component bindings referenced from data structures (registry-like). */
  registryRefs: string[];
  clusters: Cluster[];
  shell: Decl[];
  parseOk: boolean;
}

export interface Cluster {
  decls: Decl[];
  loc: number;
  imports: string[]; // specifiers (deduped)
  pkgs: string[];
  interactive: boolean;
}

function boundNames(p: N | null | undefined, out: string[] = []): string[] {
  if (!p) return out;
  switch (p.type) {
    case "Identifier":
      out.push(p.name);
      break;
    case "ObjectPattern":
      for (const pr of p.properties) boundNames(pr.type === "RestElement" ? pr.argument : pr.value, out);
      break;
    case "ArrayPattern":
      for (const e of p.elements) boundNames(e, out);
      break;
    case "AssignmentPattern":
      boundNames(p.left, out);
      break;
    case "RestElement":
      boundNames(p.argument, out);
      break;
  }
  return out;
}

const unwrap = (n: N | null | undefined): N | null | undefined => {
  while (n && TS_VALUE_WRAPPERS.has(n.type)) n = n.expression;
  return n;
};

interface Facts {
  refs: Set<string>;
  trefs: Set<string>;
  hooks: number;
  handlers: number;
  browser: boolean;
  jsx: number;
  /** names referenced inside Object/Array/Switch structures */
  dataRefs: Set<string>;
}

function collect(root: N): Facts {
  const f: Facts = { refs: new Set(), trefs: new Set(), hooks: 0, handlers: 0, browser: false, jsx: 0, dataRefs: new Set() };
  const visit = (n: N, parent: N | null, key: string, inType: boolean, inData: boolean) => {
    const t = n.type;
    if (!inType && t.startsWith("TS") && !TS_VALUE_WRAPPERS.has(t)) inType = true;
    if (t === "Identifier" || t === "IdentifierReference") {
      const skip =
        (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
        ((parent?.type === "Property" || parent?.type === "PropertyDefinition" || parent?.type === "MethodDefinition" || parent?.type === "TSPropertySignature") && key === "key" && !parent.computed) ||
        ((parent?.type === "LabeledStatement" || parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") && key === "label") ||
        (parent?.type === "TSQualifiedName" && key === "right");
      if (skip) return;
      f.trefs.add(n.name);
      if (!inType) {
        f.refs.add(n.name);
        if (BROWSER.has(n.name)) f.browser = true;
        if (inData) f.dataRefs.add(n.name);
      }
      return;
    }
    if (t === "JSXIdentifier") {
      const root = (parent?.type === "JSXOpeningElement" && key === "name" && /^[A-Z]/.test(n.name)) || (parent?.type === "JSXMemberExpression" && key === "object");
      if (root) {
        f.refs.add(n.name);
        f.trefs.add(n.name);
        if (inData) f.dataRefs.add(n.name);
      }
      return;
    }
    if (t === "JSXClosingElement") return;
    if (t === "JSXElement" || t === "JSXFragment") f.jsx++;
    if (t === "JSXAttribute" && n.name?.type === "JSXIdentifier" && /^on[A-Z]/.test(n.name.name)) f.handlers++;
    if (t === "CallExpression") {
      const c = unwrap(n.callee);
      const name = c?.type === "Identifier" ? c.name : c?.type === "MemberExpression" && c.object?.name === "React" ? c.property?.name : undefined;
      if (name && /^use[A-Z0-9]/.test(name)) f.hooks++;
    }
    const data = inData || t === "ObjectExpression" || t === "ArrayExpression" || t === "SwitchCase";
    for (const k of Object.keys(n)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = n[k];
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === "object" && typeof c.type === "string") childVisit(c, n, k);
      } else if (typeof v.type === "string") childVisit(v, n, k);
    }
    function childVisit(c: N, p: N, k: string) {
      const wrapperType = TS_VALUE_WRAPPERS.has(p.type) && k !== "expression";
      visit(c, p, k, inType || wrapperType, data);
    }
  };
  visit(root, null, "", false, false);
  return f;
}

function lineTables(content: string) {
  const starts = [0];
  const nonBlank: number[] = [0];
  let acc = 0;
  let from = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content.charCodeAt(i) === 10) {
      if (/\S/.test(content.slice(from, i))) acc++;
      nonBlank.push(acc);
      from = i + 1;
      if (i < content.length) starts.push(from);
    }
  }
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { lineOf, locBetween: (a: number, b: number) => nonBlank[b] - nonBlank[a - 1], total: acc };
}

function fnLike(n: N | null | undefined): boolean {
  const u = unwrap(n);
  return !!u && (u.type === "ArrowFunctionExpression" || u.type === "FunctionExpression");
}

export function analyzeSource(path: string, content: string, t: SplitThresholds = DEFAULT_SPLIT): Analysis | null {
  let program: N;
  try {
    const r = parseSync(path, content, { sourceType: "module" });
    program = r.program as unknown as N;
    if (r.errors?.length && !program?.body?.length) return null;
  } catch {
    return null;
  }
  const { lineOf, locBetween, total } = lineTables(content);
  const imports: Analysis["imports"] = [];
  const specs = new Set<string>();
  const pkgs = new Set<string>();
  const exportedNames = new Set<string>();
  let exports = 0;
  const decls: Decl[] = [];
  const typeNames = new Set<string>();
  let firstLine = 1;
  let sawFirst = false;
  let client = false;

  const addDecl = (names: string[], node: N, kindHint: Decl["kind"] | null, initNode: N | null, exported: boolean) => {
    const f = collect(node);
    const hasJsx = f.jsx > 0;
    const capital = names.some((n) => /^[A-Z]/.test(n) || n === "default");
    let kind: Decl["kind"];
    if (kindHint === "class") kind = "class";
    else if (kindHint === "function" || fnLike(initNode)) kind = hasJsx && capital ? "component" : "function";
    else {
      const u = unwrap(initNode);
      kind = u?.type === "CallExpression" && hasJsx && capital && u.arguments?.some((a: N) => fnLike(a)) ? "component" : "value";
      if (kind === "value" && kindHint === null && u?.type === "CallExpression" && u.arguments?.some((a: N) => fnLike(a)) && !capital) kind = "value";
    }
    if (kind === "function" && hasJsx && capital) kind = "component";
    if (kind === "component" && kindHint === "function" && !capital) kind = "function";
    const u = unwrap(initNode);
    const dup = kind === "value" && !!u && (u.type === "Literal" || u.type === "StringLiteral" || u.type === "NumericLiteral" || (u.type === "TemplateLiteral" && u.expressions.length === 0) || (u.type === "UnaryExpression" && u.argument?.type === "Literal"));
    const classInteractive = kind === "class" && /Component$/.test(node.superClass?.property?.name ?? node.superClass?.name ?? "");
    const startLine = lineOf(node.start);
    const endLine = lineOf(Math.max(node.start, node.end - 1));
    decls.push({
      names,
      kind,
      startLine,
      loc: Math.max(1, locBetween(startLine, endLine)),
      exported: exported || names.some((n) => exportedNames.has(n)),
      refs: f.refs,
      trefs: f.trefs,
      hooks: f.hooks,
      handlers: f.handlers,
      browser: f.browser,
      jsx: f.jsx,
      dup,
      interactive: f.hooks > 0 || f.handlers > 0 || f.browser || classInteractive,
    });
  };

  // pre-pass for `export { A, B }` / `export default Foo`
  for (const s of program.body as N[]) {
    if (s.type === "ExportNamedDeclaration" && !s.source) for (const sp of s.specifiers ?? []) exportedNames.add(sp.local?.name);
    if (s.type === "ExportDefaultDeclaration" && s.declaration?.type === "Identifier") exportedNames.add(s.declaration.name);
  }

  for (const s of program.body as N[]) {
    if (s.type === "ExpressionStatement" && typeof s.directive === "string") {
      if (s.directive === "use client") client = true;
      continue;
    }
    if (s.type === "ImportDeclaration") {
      const spec = s.source.value as string;
      const pkg = packageOf(spec);
      if (s.importKind === "type") continue;
      let used = false;
      for (const sp of s.specifiers ?? []) {
        if (sp.importKind === "type") continue;
        imports.push({ local: sp.local.name, pkg, spec });
        used = true;
      }
      if (used || !(s.specifiers ?? []).length) {
        specs.add(spec);
        if (pkg) pkgs.add(pkg);
      }
      continue;
    }
    if (!sawFirst) {
      sawFirst = true;
      firstLine = lineOf(s.start);
    }
    let inner: N = s;
    let exported = false;
    if (s.type === "ExportNamedDeclaration") {
      exports += s.declaration ? 1 : (s.specifiers?.length ?? 0);
      if (!s.declaration) continue;
      inner = s.declaration;
      exported = true;
    } else if (s.type === "ExportDefaultDeclaration") {
      exports++;
      exported = true;
      const d = s.declaration as N;
      if (d.type === "Identifier") continue;
      if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") {
        addDecl([d.id?.name ?? "default"], s, d.type === "ClassDeclaration" ? "class" : "function", null, true);
      } else addDecl(["default"], s, null, d, true);
      continue;
    } else if (s.type === "ExportAllDeclaration") {
      exports++;
      continue;
    }
    switch (inner.type) {
      case "FunctionDeclaration":
        addDecl([inner.id.name], s, "function", null, exported);
        break;
      case "ClassDeclaration":
        addDecl([inner.id.name], s, "class", null, exported);
        break;
      case "VariableDeclaration":
        for (const d of inner.declarations as N[]) {
          const names = boundNames(d.id);
          if (names.length) addDecl(names, d, null, d.init, exported);
        }
        break;
      case "TSEnumDeclaration":
        addDecl([inner.id.name], s, null, null, exported);
        break;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
        typeNames.add(inner.id.name);
        break;
    }
  }

  const hooks = decls.reduce((n, d) => n + d.hooks, 0);
  const jsx = decls.reduce((n, d) => n + d.jsx, 0);
  const a: Analysis = {
    loc: total,
    client,
    decls,
    imports,
    importCount: specs.size,
    packages: [...pkgs],
    exports,
    hooks,
    jsx,
    typeNames,
    firstLine,
    registryRefs: [],
    clusters: [],
    shell: [],
    parseOk: true,
  };

  // registry-like: relative component imports referenced from object/array/switch structures
  const relComps = new Set(imports.filter((i) => !i.pkg && /^[A-Z]/.test(i.local)).map((i) => i.local));
  const dataRefs = new Set<string>();
  for (const s of program.body as N[]) {
    const f = collect(s);
    for (const r of f.dataRefs) if (relComps.has(r)) dataRefs.add(r);
  }
  a.registryRefs = [...dataRefs];

  buildClusters(a, t.splitMinClusterLoc);
  return a;
}

function usedIn(d: Decl, a: Analysis): string[] {
  return a.imports.filter((i) => d.refs.has(i.local)).map((i) => i.spec);
}

function buildClusters(a: Analysis, minCluster = 0): void {
  const units = a.decls.filter((d) => !d.dup);
  const owner = new Map<string, Decl>();
  for (const d of units) for (const n of d.names) owner.set(n, d);
  const deps = new Map<Decl, Set<Decl>>(units.map((d) => [d, new Set()]));
  const indeg = new Map<Decl, number>(units.map((d) => [d, 0]));
  for (const d of units) {
    for (const r of d.refs) {
      const o = owner.get(r);
      if (o && o !== d && !deps.get(d)!.has(o)) {
        deps.get(d)!.add(o);
        indeg.set(o, indeg.get(o)! + 1);
      }
    }
  }
  const components = (nodes: Decl[]): Decl[][] => {
    const parent = new Map<Decl, Decl>(nodes.map((d) => [d, d]));
    const find = (x: Decl): Decl => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    const set = new Set(nodes);
    for (const d of nodes) for (const o of deps.get(d)!) if (set.has(o)) parent.set(find(d), find(o));
    const groups = new Map<Decl, Decl[]>();
    for (const d of nodes) {
      const r = find(d);
      groups.set(r, [...(groups.get(r) ?? []), d]);
    }
    return [...groups.values()];
  };
  const sig = (g: Decl[][]) => g.filter((c) => c.reduce((n, d) => n + d.loc, 0) >= minCluster);
  let groups = components(units);
  let shell: Decl[] = [];
  if (sig(groups).length < 2) {
    // A stateless top-level component that just composes otherwise-disjoint pieces is the "shell", not glue.
    const cand = units.filter((d) => d.kind === "component" && d.hooks === 0 && indeg.get(d) === 0 && [...deps.get(d)!].filter((o) => o.kind === "component").length >= 2);
    if (cand.length) {
      const rest = units.filter((d) => !cand.includes(d));
      const g2 = components(rest);
      if (sig(g2).length >= 2) {
        groups = g2;
        shell = cand;
      }
    }
  }
  a.shell = shell;
  a.clusters = groups
    .map((g) => {
      const specs = [...new Set(g.flatMap((d) => usedIn(d, a)))];
      return {
        decls: g.sort((x, y) => x.startLine - y.startLine),
        loc: g.reduce((n, d) => n + d.loc, 0),
        imports: specs,
        pkgs: [...new Set(specs.map(packageOf).filter((p): p is string => !!p))],
        interactive: g.some((d) => d.interactive),
      };
    })
    .sort((x, y) => y.loc - x.loc);
}

const pascal = (s: string) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());

interface Heaviness {
  isHeavy(pkg: string): boolean;
}

function heavyOf(ctx: AuditContext, t: SplitThresholds): Heaviness {
  const measured = ctx.measured ?? {};
  return {
    isHeavy: (pkg) => HEAVY_LIB.test(pkg) || HEAVY.some((h) => h.severity !== "low" && h.re.test(pkg)) || (measured[pkg] ?? 0) >= t.splitHeavyKb * 1024,
  };
}

function reachSet(ctx: AuditContext): { isClientReachable(path: string): boolean } {
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const has = (dep: string) => ctx.packages.some((p) => p.json && (p.json.dependencies?.[dep] || p.json.devDependencies?.[dep]));
  // No Next: a plain client app (all code ships) only if it is a React-like project; Node/CLI packages never are.
  const spa = !has("next") && (has("react") || has("preact") || has("solid-js") || has("vue"));
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const f of ctx.files) {
    if (!isCode(f)) continue;
    if (spa || isClient(f.content) || /(?:^|\/)pages\//.test(f.path)) {
      seen.add(f.path);
      queue.push(f.path);
    }
  }
  while (queue.length) {
    const p = queue.pop()!;
    const f = byPath.get(p)!;
    for (const i of importsOf(f.content)) {
      const t = resolveImport(p, i.spec, byPath);
      if (t && !seen.has(t.path) && isCode(t)) {
        seen.add(t.path);
        queue.push(t.path);
      }
    }
  }
  return { isClientReachable: (p) => seen.has(p) };
}

function importerIndex(ctx: AuditContext) {
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  let idx: Map<string, { file: string; clause: string }[]> | undefined;
  return (target: string) => {
    if (!idx) {
      idx = new Map();
      for (const f of ctx.files) {
        if (!isCode(f)) continue;
        for (const i of importsOf(f.content)) {
          const t = resolveImport(f.path, i.spec, byPath);
          if (t) idx.set(t.path, [...(idx.get(t.path) ?? []), { file: f.path, clause: i.clause }]);
        }
      }
    }
    return idx.get(target) ?? [];
  };
}

const GENERATED = /(?:^|\/)(?:__generated__|generated|\.contentlayer|\.graphclient)\/|\.(?:generated|gen|g)\.[cm]?[jt]sx?$|\.config\.[cm]?[jt]s$/;
const GENERATED_HEAD = /@generated|auto-?generated|do not edit|eslint-disable[^\n]*\n[^\n]*generated/i;

const uniq = <T>(a: T[]) => [...new Set(a)];

export function splitCandidate(ctx: AuditContext): Finding[] {
  const t: SplitThresholds = { ...DEFAULT_SPLIT, ...ctx.split };
  const out: Finding[] = [];
  const heavy = heavyOf(ctx, t);
  const measured = ctx.measured ?? {};
  let reach: ReturnType<typeof reachSet> | undefined;
  let importers: ReturnType<typeof importerIndex> | undefined;
  const existing = new Set(ctx.files.map((f) => f.path));

  for (const f of ctx.files) {
    if (!isCode(f) || GENERATED.test(f.path)) continue;
    if (GENERATED_HEAD.test(f.content.slice(0, 400))) continue;
    if (f.content.split("\n").length < 30) continue;
    const a = analyzeSource(f.path, f.content, t);
    if (!a || a.decls.length === 0) continue;
    reach ??= reachSet(ctx);
    const clientReach = a.client || reach.isClientReachable(f.path);
    const sigClusters = a.clusters.filter((c) => c.loc >= t.splitMinClusterLoc);
    const unitLoc = a.clusters.reduce((n, c) => n + c.loc, 0) || 1;
    const cohesion = Math.round((Math.max(0, ...a.clusters.map((c) => c.loc)) / unitLoc) * 100) / 100;
    const shellPkgs = new Set(a.shell.flatMap((d) => usedIn(d, a)).map(packageOf));
    const clusterPkgs = a.clusters.map((c) => new Set(c.pkgs));
    const uniqueHeavy = (ci: number): string[] =>
      a.clusters[ci].pkgs.filter((p) => heavy.isHeavy(p) && !clusterPkgs.some((s, j) => j !== ci && s.has(p)) && !shellPkgs.has(p));
    const kb = (pkgs: string[]) => {
      const bytes = pkgs.reduce((n, p) => n + (measured[p] ?? 0), 0);
      return bytes > 0 ? Math.round(bytes / 1024) : undefined;
    };
    const cohesionSplit = sigClusters.length >= 2;
    const heavyIdx = cohesionSplit ? a.clusters.map((c, i) => (c.loc >= t.splitMinClusterLoc && uniqueHeavy(i).length ? i : -1)).filter((i) => i >= 0) : [];
    const triggerCohesion = cohesionSplit && (a.loc >= t.splitMinLoc || heavyIdx.length > 0);
    const base = (): SplitEvidence => ({
      loc: a.loc,
      declarations: a.decls.filter((d) => d.kind !== "value" || !d.dup).length,
      exports: a.exports,
      imports: a.importCount,
      packages: a.packages.length,
      client: a.client,
      clientReachable: clientReach,
      hooks: a.hooks,
      jsxNodes: a.jsx,
      cohesion,
      clusters: [],
      uniqueHeavy: [],
      triggers: [],
    });
    const clusterEvidence = (): SplitCluster[] =>
      a.clusters.map((c, i) => ({
        name: clusterName(c, f.path),
        declarations: c.decls.flatMap((d) => d.names),
        loc: c.loc,
        imports: c.imports,
        heavy: uniqueHeavy(i),
        interactive: c.interactive,
      }));
    const godReasons: string[] = [];
    if (a.loc > t.splitGodFileLoc) godReasons.push(`${a.loc} LOC`);
    if (a.loc >= t.splitGodFileLoc / 2 && a.decls.filter((d) => d.kind !== "value").length > t.splitGodFileDecls) godReasons.push(`${a.decls.filter((d) => d.kind !== "value").length} top-level declarations`);
    if (a.importCount > t.splitGodFileImports) godReasons.push(`${a.importCount} imports`);
    const line = a.firstLine;

    if (triggerCohesion) {
      const ev = base();
      ev.clusters = clusterEvidence();
      ev.uniqueHeavy = uniq(heavyIdx.flatMap((i) => uniqueHeavy(i)));
      ev.measuredKB = kb(ev.uniqueHeavy);
      ev.triggers = [heavyIdx.length ? "heavy-cluster" : "low-cohesion", ...(godReasons.length ? ["god-file"] : [])];
      const plan = buildPlan(a, f.path, ev, ctx, existing, importers ?? (importers = importerIndex(ctx)));
      const sev: Severity = !clientReach ? "low" : heavyIdx.length ? "high" : "medium";
      const id = heavyIdx.length ? "split-candidate/heavy-cluster" : "split-candidate/low-cohesion";
      const summary = ev.clusters
        .slice(0, 5)
        .map((c) => `${c.name} (${c.declarations.slice(0, 3).join("+")}${c.declarations.length > 3 ? "+..." : ""}, ${c.loc} LOC${c.heavy.length ? `, only it needs ${c.heavy.join("/")}` : ""})`)
        .join("; ");
      const where = a.client ? '"use client" file' : clientReach ? "client-reachable file" : "server/shared file";
      out.push({
        id,
        check: "split-candidate",
        severity: sev,
        file: f.path,
        line,
        message: `${where} of ${a.loc} LOC holds ${ev.clusters.length} independent clusters (cohesion ${cohesion}): ${summary}.${ev.uniqueHeavy.length ? ` ${ev.uniqueHeavy.join(", ")} ships${ev.measuredKB ? ` (~${ev.measuredKB} KB measured)` : ""} with code that does not need it.` : ""}`,
        fix: plan,
        evidence: ev,
      });
    } else if (godReasons.length) {
      const ev = base();
      ev.clusters = clusterEvidence();
      ev.triggers = ["god-file"];
      out.push({
        id: "split-candidate/god-file",
        check: "split-candidate",
        severity: "low",
        file: f.path,
        line,
        message: `God file: ${godReasons.join(", ")}, but declarations are coupled (cohesion ${cohesion}); it is long rather than separable.`,
        fix: `Not a safe mechanical split. Extract by responsibility only if it helps reviewability: move pure helpers/constants/types to \`${stem(f.path)}.utils.ts\` and sub-components that are only used once next to their parent; keep stateful logic together. Update importers directly; no barrel.`,
        evidence: ev,
      });
    }

    // "use client" file whose static part could be a Server Component
    if (a.client) {
      const pinned = new Set<Decl>();
      const owner = new Map<string, Decl>();
      for (const d of a.decls) for (const n of d.names) owner.set(n, d);
      const stack = a.decls.filter((d) => d.interactive);
      for (const d of stack) pinned.add(d);
      while (stack.length) {
        const d = stack.pop()!;
        for (const r of d.refs) {
          const o = owner.get(r);
          // components rendered by an interactive parent stay in the client bundle with it
          if (o && !pinned.has(o)) {
            pinned.add(o);
            stack.push(o);
          }
        }
      }
      const importPkg = new Map(a.imports.map((i) => [i.local, i]));
      const eligible = a.decls.filter(
        (d) =>
          (d.kind === "component" || d.kind === "function") &&
          !pinned.has(d) &&
          ![...d.refs].some((r) => {
            const i = importPkg.get(r);
            return !!i?.pkg && !SERVER_SAFE.test(i.spec);
          }),
      );
      const eligLoc = eligible.reduce((n, d) => n + d.loc, 0);
      const interactive = a.decls.filter((d) => d.interactive);
      const total = a.decls.filter((d) => !d.dup).reduce((n, d) => n + d.loc, 0) || 1;
      if (eligLoc >= t.splitServerEligibleLoc && eligLoc / total >= 0.5) {
        const ev = base();
        ev.clusters = clusterEvidence();
        ev.triggers = ["server-eligible"];
        ev.serverEligibleLoc = eligLoc;
        const names = eligible.flatMap((d) => d.names);
        const imoved = interactive.flatMap((d) => d.names);
        const fix = interactive.length
          ? `Keep \`${f.path}\` as a Server Component: delete \`"use client"\` from it and leave ${names.join(", ")} here. Move the interactive part (${imoved.join(", ")}; imports ${uniq(interactive.flatMap((d) => usedIn(d, a))).join(", ") || "none"}) to \`${dirname(f.path) === "." ? "" : dirname(f.path) + "/"}${uniqueName(pascal(imoved[0] === "default" ? stem(f.path) : imoved[0]), extname(f.path), f.path, existing, new Set())}\` starting with \`"use client"\`, export it as default and import it here (SSR stays on; if it is heavy or below the fold wrap it in next/dynamic with a sized placeholder, never ssr:false). Pass only serializable props across the boundary. Update importers of the moved names directly; no barrel.`
          : `No hooks, event handlers or browser APIs found: remove \`"use client"\` from \`${f.path}\` so it renders on the server. If a parent client file imports it, it still ships there; then move the import up into a Server Component.`;
        out.push({
          id: "split-candidate/server-eligible",
          check: "split-candidate",
          severity: eligLoc >= t.splitServerEligibleLoc * 2 ? "medium" : "low",
          file: f.path,
          line,
          message: `"use client" file where ~${eligLoc} of ${total} LOC (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""}) use no hooks, handlers or browser APIs${interactive.length ? `; only ${imoved.slice(0, 4).join(", ")} ${interactive.length > 1 ? "need" : "needs"} the client` : ""}.`,
          fix,
          evidence: ev,
        });
      }
    }

    // registry/barrel-like: many components imported only to sit in a lookup structure
    if (a.registryRefs.length >= t.splitRegistryMinImports) {
      const ev = base();
      ev.triggers = ["registry"];
      ev.clusters = [];
      out.push({
        id: "split-candidate/registry",
        check: "split-candidate",
        severity: clientReach ? "medium" : "low",
        file: f.path,
        line,
        message: `Registry-like file: imports ${a.registryRefs.length} components (${a.registryRefs.slice(0, 4).join(", ")}, ...) that are only placed in lookup structures and never rendered together, so every one is bundled with the registry.`,
        fix: `Replace the static imports with per-entry \`dynamic(() => import("./X"))\` (SSR on, a sized \`loading\` placeholder; never ssr:false) so only the blocks a page renders are loaded, or resolve the component in a Server Component and pass the rendered element down. Keep always-visible entries (hero/header) as static imports. Check with \`wimb scan\` (static-component-map).`,
        evidence: ev,
      });
    }
  }
  return out;
}

const stem = (p: string) => basename(p).replace(/\.[^.]+$/, "");

function clusterName(c: Cluster, filePath: string): string {
  const pick = [...c.decls].sort((x, y) => Number(y.exported) - Number(x.exported) || Number(y.kind === "component") - Number(x.kind === "component") || y.loc - x.loc)[0];
  const n = pick.names[0];
  return n === "default" ? pascal(stem(filePath)) : n;
}

function uniqueName(name: string, ext: string, file: string, existing: Set<string>, taken: Set<string>): string {
  const dir = dirname(file) === "." ? "" : dirname(file) + "/";
  let n = name;
  for (let i = 2; existing.has(dir + n + ext) || taken.has(n); i++) n = name + i;
  taken.add(n);
  return n + ext;
}

function buildPlan(a: Analysis, file: string, ev: SplitEvidence, ctx: AuditContext, existing: Set<string>, importers: ReturnType<typeof importerIndex>): string {
  const dir = dirname(file) === "." ? "" : dirname(file) + "/";
  const ext = extname(file);
  const jsxExt = ext === ".js" || ext === ".jsx" ? ".jsx" : ".tsx";
  const taken = new Set<string>([stem(file)]);
  const stays = a.shell.length ? null : (a.clusters.find((_, i) => !ev.clusters[i].heavy.length) ?? a.clusters[0]);
  const L: string[] = [];
  const names = (d: Decl[]) => d.flatMap((x) => x.names);
  const movedNames: string[] = [];
  let step = 1;
  L.push(
    a.shell.length
      ? `1) Keep \`${file}\` as the thin composer: ${names(a.shell).join(", ")} stays and imports the new modules${a.client && !a.shell.some((d) => d.interactive) && a.clusters.some((c) => c.interactive) ? '; drop "use client" from it (the shell is static, each interactive module gets its own)' : ""}.`
      : `1) Keep \`${file}\` for the largest cluster (${names(stays!.decls).join(", ")}, ${stays!.loc} LOC)${a.client ? "; its \"use client\" stays" : ""}.`,
  );
  step++;
  const rest = a.shell.length ? a.clusters : a.clusters.filter((c) => c !== stays);
  const dynTargets: string[] = [];
  rest.forEach((c) => {
    const i = a.clusters.indexOf(c);
    const cl = ev.clusters[i];
    const hasJsx = c.decls.some((d) => d.jsx > 0);
    const fileName = uniqueName(cl.name, hasJsx ? jsxExt : ext === ".js" || ext === ".jsx" ? ".js" : ".ts", file, existing, taken);
    movedNames.push(...cl.declarations);
    const bits = [`${step}) Create \`${dir}${fileName}\`: move ${cl.declarations.join(", ")} (${c.loc} LOC)`];
    bits.push(`and the imports it uses (${c.imports.length ? c.imports.join(", ") : "none"})`);
    if (a.client && c.interactive) bits.push('and start the file with "use client"');
    else if (a.client) bits.push("with no directive (static, renders on the server)");
    bits.push(`; export \`${cl.name}\` as default`);
    if (cl.heavy.length) {
      dynTargets.push(cl.name);
      bits.push(`. It is the only user of ${cl.heavy.join(", ")}${kbText(ctx, cl.heavy)}: render it with \`const ${cl.name} = dynamic(() => import("./${fileName.replace(/\.[^.]+$/, "")}"), { loading: () => <div style={{ height: /* its real height */ 320 }} aria-hidden /> })\` from next/dynamic (SSR stays on, placeholder sized to avoid layout shift; never ssr:false)`);
    }
    L.push(bits.join(" ").replace(" ;", ";").replace(" .", ".") + ".");
    step++;
  });
  const shared = a.decls.filter((d) => d.dup).flatMap((d) => d.names);
  const typeShared = [...a.typeNames].filter((tn) => a.clusters.filter((c) => c.decls.some((d) => d.trefs.has(tn))).length > 1);
  if (shared.length || typeShared.length) {
    L.push(`${step}) Shared leftovers: ${shared.length ? `copy the literal constants ${shared.join(", ")} into each module that uses them` : ""}${shared.length && typeShared.length ? "; " : ""}${typeShared.length ? `put types ${typeShared.join(", ")} in \`${dir}${stem(file)}.types.ts\` (import type)` : ""}.`);
    step++;
  }
  const imp = importers(file).filter((i) => movedNames.some((n) => new RegExp(`\\b${n}\\b`).test(i.clause)));
  L.push(
    `${step}) Update importers directly to the new modules${imp.length ? ` (${uniq(imp.map((i) => i.file)).slice(0, 5).join(", ")}${imp.length > 5 ? ", ..." : ""})` : ""}; do not leave re-exports or add a barrel.`,
  );
  if (dynTargets.length && !a.shell.length) L.push(`Load ${dynTargets.join(", ")} with next/dynamic where it is rendered.`);
  L.push("Then run typecheck/build and `wimb wins` to confirm the chunk split.");
  return L.join(" ");
}

function kbText(ctx: AuditContext, pkgs: string[]): string {
  const bytes = pkgs.reduce((n, p) => n + (ctx.measured?.[p] ?? 0), 0);
  return bytes > 0 ? ` (~${Math.round(bytes / 1024)} KB measured)` : "";
}
