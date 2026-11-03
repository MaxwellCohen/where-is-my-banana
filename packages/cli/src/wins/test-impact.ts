import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import type { TestImpact, Win } from "./types.js";

type Runner = "vitest" | "jest";

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", ".wimb", "build", "coverage"]);
const SRC_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

interface Index {
  files: string[];
  fileSet: Set<string>;
  tests: string[];
  imports: Map<string, string[]>; // file -> resolved project-relative files
  importers: Map<string, string[]> | null; // non-test source -> importers (lazy)
}

const cache = new Map<string, Index>();

export function clearTestImpactCache(): void {
  cache.clear();
}

function walk(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, join(dir, e.name), out);
    } else if (SRC_EXT.test(e.name)) {
      out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
    }
  }
}

function getIndex(root: string): Index {
  let idx = cache.get(root);
  if (!idx) {
    const files: string[] = [];
    walk(root, root, files);
    files.sort();
    idx = {
      files,
      fileSet: new Set(files),
      tests: files.filter((f) => TEST_FILE.test(f)),
      imports: new Map(),
      importers: null,
    };
    cache.set(root, idx);
  }
  return idx;
}

function specifiers(text: string): string[] {
  const out = new Set<string>();
  const res = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
    /\b(?:vi|jest)\.(?:mock|doMock|requireActual|importActual)\s*\(\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.add(m[1]!);
  return [...out];
}

function candidates(base: string): string[] {
  const noExt = base.replace(/\.[cm]?[jt]sx?$/, "");
  return [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => noExt + e), ...EXTS.map((e) => `${base}/index${e}`)];
}

function resolve(idx: Index, from: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    return candidates(base).find((c) => idx.fileSet.has(c)) ?? null;
  }
  const m = /^(?:@|~)\/(.+)$/.exec(spec);
  if (!m) return null;
  const rest = m[1]!;
  for (const c of candidates(rest)) {
    const hit = idx.files.find((f) => f === c || f.endsWith("/" + c));
    if (hit) return hit;
  }
  return null;
}

function importsOf(root: string, idx: Index, file: string): string[] {
  let r = idx.imports.get(file);
  if (!r) {
    let text = "";
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {}
    r = [...new Set(specifiers(text).map((s) => resolve(idx, file, s)).filter((x): x is string => !!x))];
    idx.imports.set(file, r);
  }
  return r;
}

function sourceImporters(root: string, idx: Index): Map<string, string[]> {
  if (!idx.importers) {
    const m = new Map<string, string[]>();
    for (const f of idx.files) {
      if (TEST_FILE.test(f)) continue;
      for (const t of importsOf(root, idx, f)) {
        const a = m.get(t);
        if (a) a.push(f);
        else m.set(t, [f]);
      }
    }
    idx.importers = m;
  }
  return idx.importers;
}

export function detectTestRunner(projectRoot: string): { runner: Runner | null } {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  } catch {
    return { runner: null };
  }
  const scripts = pkg.scripts ?? {};
  const testScript = String(scripts.test ?? "");
  const pick = (s: string): Runner | null => {
    const v = s.indexOf("vitest");
    const j = s.indexOf("jest");
    if (v >= 0 && (j < 0 || v < j)) return "vitest";
    if (j >= 0) return "jest";
    return null;
  };
  const fromTest = pick(testScript);
  if (fromTest) return { runner: fromTest };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return { runner: "vitest" };
  if (deps.jest) return { runner: "jest" };
  return { runner: pick(Object.values(scripts).join("\n")) };
}

function detectPm(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npx";
}

const W_GETBY =
  "sync getBy* queries on the lazy component will fail: use `await screen.findBy*` or `waitFor` because lazy rendering is async";
const W_TIMERS =
  "fake timers can stall Suspense/next/dynamic resolution: wrap in `await act(async () => { await vi.runAllTimersAsync() })` (jest: `jest.runAllTimersAsync()`) or mock next/dynamic";
const W_SNAP =
  "snapshot tests will capture the loading fallback: update snapshots after awaiting the component or mock next/dynamic";

function warningsFor(file: string, text: string): string[] {
  const out: string[] = [];
  if (/\b(?:screen\.)?getBy[A-Z]\w*\s*\(|\bgetByRole\b|\bgetByText\b/.test(text)) out.push(`${file}: ${W_GETBY}`);
  if (/useFakeTimers/.test(text)) out.push(`${file}: ${W_TIMERS}`);
  if (/toMatchSnapshot|toMatchInlineSnapshot/.test(text)) out.push(`${file}: ${W_SNAP}`);
  return out;
}

const MOCK_BODY = `  default: (loader) => {
    const React = require('react');
    let Loaded = null;
    const ready = Promise.resolve(loader()).then((m) => { Loaded = (m && m.default) || m; });
    const Dynamic = (props) => (Loaded ? React.createElement(Loaded, props) : null);
    Dynamic.preload = () => ready;
    return Dynamic;
  },`;

function buildSetupMock(runner: Runner): string {
  const note = "// Optional: eager next/dynamic for tests. After render, `await` one tick or use findBy* queries.";
  if (runner === "vitest") {
    return `${note}
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  return {
    default: (loader) => {
      let Loaded = null;
      const ready = Promise.resolve(loader()).then((m) => { Loaded = (m && m.default) || m; });
      const Dynamic = (props) => (Loaded ? React.createElement(Loaded, props) : null);
      Dynamic.preload = () => ready;
      return Dynamic;
    },
  };
});`;
  }
  return `${note}
jest.mock('next/dynamic', () => ({
  __esModule: true,
${MOCK_BODY}
}));`;
}

export async function findTestImpact(projectRoot: string, affected: string[]): Promise<TestImpact | null> {
  const idx = getIndex(projectRoot);
  if (idx.tests.length === 0) return null;
  const aff = new Set(affected.map((a) => a.split(sep).join("/")));
  const hop = new Set<string>();
  const importers = sourceImporters(projectRoot, idx);
  for (const a of aff) for (const i of importers.get(a) ?? []) hop.add(i);

  const files: string[] = [];
  const warnings = new Set<string>();
  for (const t of idx.tests) {
    const imps = importsOf(projectRoot, idx, t);
    if (!imps.some((i) => aff.has(i) || hop.has(i))) continue;
    files.push(t);
    let text = "";
    try {
      text = readFileSync(join(projectRoot, t), "utf8");
    } catch {}
    for (const w of warningsFor(t, text)) warnings.add(w);
  }
  if (files.length === 0) return null;
  files.sort();

  const { runner } = detectTestRunner(projectRoot);
  const list = files.join(" ");
  const pm = detectPm(projectRoot);
  const command =
    runner === "vitest"
      ? `${pm === "npx" ? "npx" : `${pm} exec`} vitest run ${list}`
      : runner === "jest"
        ? `${pm === "npx" ? "npx" : `${pm} exec`} jest --runTestsByPath ${list}`
        : undefined;
  const impact: TestImpact = { files, warnings: [...warnings], runner };
  if (command) impact.command = command;
  impact.setupMock = buildSetupMock(runner ?? "jest");
  return impact;
}

const KIND_HINTS: [RegExp, string][] = [
  [/getBy\*/, "Switch sync getBy* queries to `await screen.findBy*` / `waitFor`."],
  [/fake timers/, "Flush fake timers asynchronously (`runAllTimersAsync`) or mock next/dynamic."],
  [/snapshot/, "Re-record snapshots after awaiting the component, or mock next/dynamic."],
];

export async function attachTestImpact(wins: Win[], projectRoot: string): Promise<void> {
  const memo = new Map<string, Promise<TestImpact | null>>();
  for (const w of wins) {
    if (w.fixKind !== "lazy" && w.fixKind !== "guard-heavy") continue;
    const affected = [w.edge.importer, ...(w.edge.packageName ? [] : [w.edge.imported])];
    const key = affected.join("\0");
    let p = memo.get(key);
    if (!p) memo.set(key, (p = findTestImpact(projectRoot, affected)));
    const impact = await p;
    if (!impact) continue;
    w.testImpact = impact;
    const n = impact.warnings.length;
    w.edit.steps.push(`Update/run these tests: ${impact.files.join(", ")} (${n} warning(s) below)`);
    for (const [re, hint] of KIND_HINTS) {
      if (impact.warnings.some((x) => re.test(x))) w.edit.steps.push(hint);
    }
    if (impact.command) w.edit.verify = `${impact.command} && ${w.edit.verify}`;
  }
}

export function formatTestImpactMarkdown(w: Win): string[] {
  const t = w.testImpact;
  if (!t) return [];
  const lines = ["", "**Tests affected**", ""];
  for (const f of t.files) lines.push(`- \`${f}\``);
  for (const x of t.warnings) lines.push(`- warning: ${x}`);
  if (t.command) lines.push("", `Run: \`${t.command}\``);
  if (t.setupMock) {
    lines.push("", "Optional setup mock (eager `next/dynamic` in tests):", "", "```js", t.setupMock, "```");
  }
  return lines;
}
