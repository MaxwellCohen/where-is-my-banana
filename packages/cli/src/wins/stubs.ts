import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { packageNameFromPath } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import { buildRouteGraph, chainFrom, lostBytes, parentsWithout } from "./reach.js";
import type { Confidence, StubInfo, Win } from "./types.js";

/**
 * Side-effect-blocked imports: a package P in the client graph whose ONLY importers are barrel/re-export modules
 * of "sideEffects": false packages, where P looks server-only. The app uses some export of the barrel that doesn't
 * need P, yet the bundler keeps P because it can't prove the re-exporting module is side-effect free.
 * Heuristic: we never see which export references P at the AST level; we read the barrel's re-export statements.
 */

const FRAMEWORK = new Set(["next", "react", "react-dom", "scheduler"]);
const NODE_BUILTINS_RE =
  /(?:require\(\s*|from\s*|import\(\s*)["'](?:node:)?(?:fs|fs\/promises|net|tls|child_process|dns|dgram|http2|worker_threads|cluster)["']/;
const MAX_SCAN_FILES = 6;
const MAX_SCAN_BYTES = 300_000;

interface PkgJson {
  sideEffects?: unknown;
  browser?: unknown;
  exports?: unknown;
}

function pkgRootOf(modulePath: string): string | null {
  const marker = "node_modules/";
  const idx = modulePath.lastIndexOf(marker);
  const name = packageNameFromPath(modulePath);
  if (idx < 0 || !name) return null;
  return modulePath.slice(0, idx + marker.length + name.length);
}

function readText(path: string, cap = MAX_SCAN_BYTES): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").slice(0, cap);
  } catch {
    return null;
  }
}

function readPkg(projectRoot: string, modulePath: string, cache: Map<string, PkgJson | null>): PkgJson | null {
  const root = pkgRootOf(modulePath);
  if (!root) return null;
  if (cache.has(root)) return cache.get(root)!;
  let json: PkgJson | null = null;
  const text = readText(join(projectRoot, root, "package.json"), 2_000_000);
  if (text) {
    try {
      json = JSON.parse(text) as PkgJson;
    } catch {
      json = null;
    }
  }
  cache.set(root, json);
  return json;
}

/** Strong signals mean "does not belong in a browser bundle"; the weak `sdk-name` only hints. */
function nodeOnlySignals(name: string, pkg: PkgJson | null, files: string[]): { strong: string[]; weak: string[] } {
  const strong: string[] = [];
  const weak: string[] = [];
  if (/(^|[-/@._])node([-/._]|$)/.test(name)) strong.push("node-in-name");
  if (/-sdk$/.test(name)) weak.push("sdk-name");
  if (pkg) {
    const b = pkg.browser;
    if (b === false || (b && typeof b === "object" && Object.values(b as object).some((v) => v === false))) strong.push("browser-field-false");
    const ex = pkg.exports;
    if (ex && typeof ex === "object") {
      const root = ((ex as Record<string, unknown>)["."] ?? ex) as Record<string, unknown>;
      if (root && typeof root === "object" && "node" in root && !("browser" in root) && !("default" in root)) strong.push("exports-node-only");
    }
  }
  if (files.some((f) => NODE_BUILTINS_RE.test(f))) strong.push("node-builtins");
  return { strong, weak };
}

type Reexport = { kind: "named"; names: Set<string> } | { kind: "star" } | { kind: "none" };

const stripExt = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");

/** Does `src` (module at importerPath) re-export from the module at importedPath (or package P)? */
function reexportOf(src: string, importerPath: string, importedPath: string, pkgName: string): Reexport {
  const target = stripExt(importedPath);
  const matches = (spec: string): boolean => {
    if (spec === pkgName || spec.startsWith(`${pkgName}/`)) return true;
    if (!spec.startsWith(".")) return false;
    const resolved = stripExt(posix.normalize(posix.join(posix.dirname(importerPath), spec)));
    return resolved === target || target.startsWith(`${resolved}/`);
  };
  const names = new Set<string>();
  let star = false;
  let found = false;
  const esm = /export\s*(\*(?:\s+as\s+([\w$]+))?|\{([^}]*)\})\s*from\s*["']([^"']+)["']/g;
  for (let m: RegExpExecArray | null; (m = esm.exec(src)); ) {
    if (!matches(m[4])) continue;
    found = true;
    if (m[3] !== undefined) {
      for (const part of m[3].split(",")) {
        const n = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (n) names.add(n);
      }
    } else if (m[2]) names.add(m[2]);
    else star = true;
  }
  const cjsStar = /__(?:exportStar|export)\(\s*require\(\s*["']([^"']+)["']\s*\)/g;
  for (let m: RegExpExecArray | null; (m = cjsStar.exec(src)); ) {
    if (matches(m[1])) {
      found = true;
      star = true;
    }
  }
  if (!found) return { kind: "none" };
  return star ? { kind: "star" } : { kind: "named", names };
}

/** Names the app module imports from package `pkg`; "*" when unknowable (namespace import, no static import found). */
function usedNamesFrom(src: string | null, pkg: string): Set<string> | "*" {
  if (!src) return "*";
  const used = new Set<string>();
  let any = false;
  const re = /import\s+(type\s+)?([^;'"]*?)\s+from\s*["']([^"']+)["']/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    if (m[3] !== pkg && !m[3].startsWith(`${pkg}/`)) continue;
    if (m[1]) continue;
    any = true;
    const clause = m[2];
    if (/\*\s+as\s/.test(clause)) return "*";
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (n) used.add(n);
      }
    }
    if (/^\s*[\w$]+\s*(,|$)/.test(clause) && !clause.trim().startsWith("{")) used.add("default");
  }
  return any ? used : "*";
}

export function stubFileName(pkg: string): string {
  return `stubs/${pkg.replace(/^@/, "").replace(/\//g, "__")}.js`;
}

export function stubFileContent(pkg: string): string {
  return [
    `// Browser-only stub for "${pkg}". Server builds keep the real package; wire it up via resolveAlias (client only).`,
    `// Any property access or call returns another inert stub, so named imports resolve; it never throws at import time.`,
    `const stub = new Proxy(function () {}, {`,
    `  get: (_t, key) => (key === "__esModule" ? true : key === "then" ? undefined : stub),`,
    `  apply: () => undefined,`,
    `  construct: () => stub,`,
    `});`,
    `module.exports = stub;`,
    ``,
  ].join("\n");
}

function stubInfo(pkg: string, via: string[], signals: string[]): StubInfo {
  const stubPath = stubFileName(pkg);
  return {
    package: pkg,
    via,
    signals,
    stubPath,
    stubContent: stubFileContent(pkg),
    turbopackConfig: `// next.config.js (Next 15/16)\nturbopack: { resolveAlias: { '${pkg}': { browser: './${stubPath}' } } }`,
    webpackConfig: `// next.config.js (webpack builds; client compiler only)\nwebpack: (config, { isServer }) => {\n  if (!isServer) config.resolve.alias['${pkg}$'] = require('path').resolve(__dirname, '${stubPath}'); // or = false\n  return config;\n}`,
  };
}

export interface StubOptions {
  minBytes?: number;
  /** Override the verify command prefix (the project root is substituted otherwise). */
  projectRoot: string;
}

export function detectStubWins(graph: ParsedGraph, opts: StubOptions): Win[] {
  const minBytes = opts.minBytes ?? 2048;
  const projectRoot = opts.projectRoot;
  const pkgCache = new Map<string, PkgJson | null>();
  const wins = new Map<string, Win>();

  for (const route of [...graph.routes.keys()].sort()) {
    const rg = buildRouteGraph(graph, route);
    if (!rg) continue;
    const n = rg.idents.length;
    const pkgOf = rg.paths.map((p) => (p ? packageNameFromPath(p) : null));
    const byPkg = new Map<string, number[]>();
    for (let i = 1; i < n; i++) {
      const p = pkgOf[i];
      if (p && !FRAMEWORK.has(p)) (byPkg.get(p) ?? byPkg.set(p, []).get(p)!).push(i);
    }

    interface Cand { pkg: string; entries: Array<[number, number]>; lost: number; parent: number[]; win: Win }
    const cands: Cand[] = [];
    for (const [P, nodes] of byPkg) {
      const entries: Array<[number, number]> = [];
      let direct = false;
      for (const v of nodes) {
        for (const u of rg.preds[v]) {
          if (u === 0 || pkgOf[u] === null) direct = true; // seed or app code imports it itself
          else if (pkgOf[u] !== P) entries.push([u, v]);
        }
      }
      if (direct || entries.length === 0) continue;
      const via = [...new Set(entries.map(([u]) => pkgOf[u]!))];
      if (!via.every((a) => {
        const u = entries.find(([x]) => pkgOf[x] === a)![0];
        return readPkg(projectRoot, rg.paths[u], pkgCache)?.sideEffects === false;
      })) continue;

      const files = nodes.slice(0, MAX_SCAN_FILES).map((i) => readText(join(projectRoot, rg.paths[i])) ?? "");
      const sig = nodeOnlySignals(P, readPkg(projectRoot, rg.paths[nodes[0]], pkgCache), files);
      if (sig.strong.length + sig.weak.length === 0) continue;

      // Barrel check: every entry must be a re-export; if the app names an export that re-exports P, it's genuinely used.
      let certain = true;
      let blocked = true;
      for (const [u, v] of entries) {
        const re = reexportOf(readText(join(projectRoot, rg.paths[u])) ?? "", rg.paths[u], rg.paths[v], P);
        if (re.kind === "none") { blocked = false; break; }
        if (re.kind === "star") { certain = false; continue; }
        const chain = chainFrom(rg, rg.parent, u);
        const a = pkgOf[u]!;
        const k = chain.findIndex((p) => packageNameFromPath(p) === a);
        const appImporter = k > 0 && packageNameFromPath(chain[k - 1]) === null ? chain[k - 1] : null;
        const used = usedNamesFrom(appImporter ? readText(join(projectRoot, appImporter)) : null, a);
        if (used === "*") { certain = false; continue; }
        if ([...re.names].some((x) => used.has(x))) { blocked = false; break; }
      }
      if (!blocked) continue;

      const parent = parentsWithout(rg, (u, v) => pkgOf[v] === P && pkgOf[u] !== P);
      const lost = lostBytes(rg, parent);
      if (lost < minBytes) continue;
      const [u0, v0] = entries[0];
      const info = stubInfo(P, via, [...sig.strong, ...sig.weak]);
      const confidence: Confidence = certain && sig.strong.length > 0 ? "high" : sig.strong.length > 0 ? "medium" : "low";
      cands.push({
        pkg: P,
        entries,
        lost,
        parent,
        win: {
          id: `stub-alias:${rg.paths[u0]}:${P}`,
          fixKind: "stub-alias",
          safety: "needs-review",
          safetyReasons: ["client-stub"],
          usage: "unknown",
          edge: { importer: rg.paths[u0], imported: rg.paths[v0], packageName: P },
          routes: { [route]: lost },
          totalSavedBytes: lost,
          predictedSavedBytes: lost,
          confidence,
          byteSource: "measured",
          chain: [...chainFrom(rg, rg.parent, u0), rg.paths[v0]],
          edit: stubEdit(P, info, via, rg.paths[u0], route, projectRoot),
          stub: info,
        },
      });
    }

    // Nested packages (only reachable through an already-flagged one) are covered by the outer stub.
    cands.sort((a, b) => b.lost - a.lost);
    const chosen: Cand[] = [];
    for (const c of cands) {
      const nodes = byPkg.get(c.pkg)!;
      if (chosen.some((o) => nodes.every((i) => o.parent[i] === -1))) continue;
      chosen.push(c);
      const prev = wins.get(c.win.id);
      if (prev) {
        prev.routes[route] = c.lost;
        prev.totalSavedBytes = Math.max(prev.totalSavedBytes, c.lost);
        prev.predictedSavedBytes = prev.totalSavedBytes;
      } else wins.set(c.win.id, c.win);
    }
  }
  return [...wins.values()];
}

function stubEdit(P: string, info: StubInfo, via: string[], importer: string, route: string, projectRoot: string) {
  const verify = `pnpm exec wimb wins --cwd ${JSON.stringify(projectRoot)} --compare .wimb/wins.json  # rebuild + compare route: ${route}; expect first-load to drop`;
  return {
    summary: `Stub ${P} out of the client bundle (only reached via ${via.join(", ")} re-exports in ${importer})`,
    replacementImport: info.turbopackConfig,
    steps: [
      `${via.join(", ")} is marked "sideEffects": false but its barrel (${importer}) still pulls in ${P}, which looks server-only.`,
      `Create ${info.stubPath} with the stub content (see wins.json stub.stubContent).`,
      "Add the Turbopack (Next 15/16) resolveAlias or the webpack client-only alias from wins.md / wins.json (stub.turbopackConfig, stub.webpackConfig).",
      "The alias is browser/client-only (isServer=false / `browser` condition), so server code keeps the real package.",
      "Risk (client-stub): if client code really calls this package it will silently no-op. Grep client components for imports that reach it first.",
      `Rebuild, run the verify command, then exercise the page/route that uses ${P} on the server and confirm it still works.`,
    ],
    verify,
  };
}
