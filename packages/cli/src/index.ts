#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { dirname, join, resolve } from "node:path";
import { scan } from "./scan.js";
import { buildDualRouteForest } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import { writeVizGraph, writeVizFile } from "./viz.js";
import { existsSync, readFileSync } from "node:fs";
import { FlagError, parseAuditChecks, parseExitThreshold, parseFailOn, parseFormats, parseNumberFlag, parseTop, validateWinsReport } from "./index-flags.js";
import { collectFindings, runAudit } from "./audit/index.js";
import { formatAuditTerminal, writeAudit } from "./audit/output.js";
import { applyFixes, formatFixSummary } from "./audit/fix.js";
import { makeBaseline, readBaseline, writeBaseline } from "./audit/baseline.js";
import { runLive, writeLive, formatTerminal } from "./live/index.js";
import { DEFAULT_UA, MOBILE_UA } from "./live/net.js";
import { loadConfig } from "./config.js";
import { DEFAULT_VISUALIZER_URL, buildPayload, inlineUrl, launchBrowser, serveOnce } from "./open.js";
import { runWins, runNextAnalyze, loadGraph } from "./wins/index.js";
import { formatWhy, whyReport } from "./why/index.js";
import { buildRouteGraph, type RouteGraph } from "./wins/reach.js";
import { formatPackageTable, packageTable } from "./wins/packages.js";
import { isViteProject } from "./sources/vite.js";
import { formatWinsTerminal, writeWins } from "./wins/output.js";
import { checkBudget, compareWins } from "./wins/compare.js";
import { acceptBaseline, applyRevert, judge, planRevert, recordVerify, snapshotFileState, winFiles, wimbPath } from "./wins/verify.js";
import type { WinsReport } from "./wins/types.js";
import { formatValidationTerminal, runValidate, writeValidation } from "./wins/validate.js";
import { parseSample, parseUrlFlag, runSpeed } from "./speed/index.js";

function fail(err: unknown): void {
  console.error(`wimb: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof FlagError ? 2 : 1;
}

const scanCommand = defineCommand({
  meta: { name: "scan", description: "Scan a Next.js App Router project for client bloat" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    build: {
      type: "boolean",
      description: "Deep scan with next analyze (measured bytes). Next 16.4+ uses `next analyze export`.",
      default: false,
    },
    "dist-dir": {
      type: "string",
      description: "Override distDir / point at pre-built analyze output",
    },
    snapshot: {
      type: "string",
      description: "Named next analyze snapshot to capture or export (Next 16.4+)",
    },
    "analyze-export": {
      type: "string",
      description: "Read measured bytes from a next analyze export JSONL file (.jsonl or .jsonl.gz)",
    },
    format: {
      type: "string",
      description: "Output formats: json,md (comma-separated)",
      default: "json,md",
    },
    "exit-threshold": {
      type: "string",
      description: "Exit 1 if findings at or above this severity",
      default: "error",
    },
    "forest-compact": {
      type: "boolean",
      description: "Omit AST and JSX trees from forest.json entries",
      default: false,
    },
    "no-ast": {
      type: "boolean",
      description: "Alias for --forest-compact",
      default: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let formats: string[];
    let exitThreshold: "error" | "warning" | "info";
    try {
      formats = parseFormats(args.format);
      exitThreshold = parseExitThreshold(args["exit-threshold"]);
    } catch (err) {
      return fail(err);
    }
    const code = await scan({
      projectRoot,
      build: args.build,
      distDir: args["dist-dir"],
      snapshot: args.snapshot,
      analyzeExportPath: args["analyze-export"]
        ? resolve(projectRoot, args["analyze-export"])
        : undefined,
      formats,
      exitThreshold,
      forestCompact: args["forest-compact"] || args["no-ast"],
    });
    process.stdout.write("", () => process.exit(code));
  },
});

const vizBuildCommand = defineCommand({
  meta: {
    name: "build",
    description:
      "Build a route-rooted import forest JSON from next analyze export OR experimental-analyze binary artifacts",
  },
  args: {
    "analyze-export": {
      type: "string",
      description: "Path to next analyze export JSONL (.jsonl or .jsonl.gz). Optional if binary analyze data exists.",
    },
    "dist-dir": {
      type: "string",
      description: "App distDir with diagnostics/analyze (default .next). Used when --analyze-export is omitted.",
    },
    output: {
      type: "string",
      description: "Output path for viz graph JSON",
      default: ".wimb/bundle-graph.json",
    },
    cwd: {
      type: "string",
      description: "App / project root (binary path lookup + relative paths)",
      default: process.cwd(),
    },
    async: {
      type: "boolean",
      description: "Include async dependency edges (export JSONL only)",
      default: false,
    },
    traced: {
      type: "boolean",
      description: "Include traced dependency edges (export JSONL only)",
      default: false,
    },
    vite: {
      type: "boolean",
      description: "Analyze a Vite app via an in-process build (auto-detected when vite is a dependency and next is not)",
    },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    const outputPath = resolve(projectRoot, args.output);
    const analyzeExport = args["analyze-export"]
      ? resolve(projectRoot, args["analyze-export"] as string)
      : undefined;
    const viz = await writeVizGraph({
      analyzeExportPath: analyzeExport,
      projectRoot,
      distDir: args["dist-dir"],
      outputPath,
      includeAsync: args.async,
      includeTraced: args.traced,
      vite: args.vite,
    });
    console.log(
      `wimb: wrote ${outputPath} (${viz.routes.length} routes, snapshot ${viz.meta.snapshotName ?? "unknown"})`,
    );
  },
});

const vizCommand = defineCommand({
  meta: {
    name: "viz",
    description: "Build payloads for the WIMB bundle forest visualizer",
  },
  subCommands: { build: vizBuildCommand },
});

const whyCommand = defineCommand({
  meta: { name: "why", description: "Explain why a package or file is in the client first-load bundle (import chains)" },
  args: {
    target: { type: "positional", description: "Package name, path fragment or glob (e.g. moment, @scope/pkg, components/Chart.tsx, @scope/*); omit with --table", required: false },
    table: { type: "boolean", description: "Print the node_modules package table (package, KB, % of route, routes, top importer)", default: false },
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    "analyze-export": { type: "string", description: "next analyze export JSONL (.jsonl or .jsonl.gz)" },
    "dist-dir": { type: "string", description: "distDir with diagnostics/analyze (default .next)" },
    snapshot: { type: "string", description: "Named next analyze snapshot" },
    analyze: { type: "boolean", description: "Run `next analyze --output` first (use --no-analyze to reuse existing data)", default: true },
    vite: { type: "boolean", description: "Analyze a Vite app via an in-process build (auto-detected)" },
    route: { type: "string", description: "Only routes containing this substring" },
    "all-routes": { type: "boolean", description: "List every route that includes the target", default: false },
    chains: { type: "string", description: "Max distinct import chains per route", default: "3" },
    json: { type: "boolean", description: "Print the report as JSON", default: false },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let report;
    try {
      const chains = parseNumberFlag("chains", args.chains) ?? 3;
      const snapshot = args.snapshot ?? (args.analyze ? "wins" : undefined);
      const vite = args.vite ?? isViteProject(projectRoot);
      if (!vite && args.analyze && !args["analyze-export"]) await runNextAnalyze(projectRoot, snapshot!);
      const graph = await loadGraph({
        projectRoot,
        analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : undefined,
        distDir: args["dist-dir"],
        snapshot,
        vite,
        analyzed: args.analyze,
      });
      if (!args.target) {
        if (!args.table) throw new FlagError("why needs a <target> (or --table for the package table)");
        const rgs = [...graph.routes.keys()].sort().map((r) => buildRouteGraph(graph, r)).filter((r): r is RouteGraph => !!r);
        const rows = packageTable(rgs);
        console.log(args.json ? JSON.stringify(rows, null, 2) : formatPackageTable(rows).join("\n"));
        return process.stdout.write("", () => process.exit(0)) as unknown as void;
      }
      report = whyReport(graph, args.target, { route: args.route, allRoutes: args["all-routes"], chains });
    } catch (err) {
      return fail(err);
    }
    console.log(args.json ? JSON.stringify(report, null, 2) : formatWhy(report));
    const exitCode = report.routes.length ? 0 : 1;
    process.stdout.write("", () => process.exit(exitCode));
  },
});

const graphArgs = {
  cwd: { type: "string", description: "Project root", default: process.cwd() },
  "analyze-export": { type: "string", description: "next analyze export JSONL (.jsonl or .jsonl.gz)" },
  "dist-dir": { type: "string", description: "distDir with diagnostics/analyze (default .next)" },
  snapshot: { type: "string", description: "Named next analyze snapshot" },
  analyze: { type: "boolean", description: "Run `next analyze --output` first (use --no-analyze to reuse existing data)", default: true },
  vite: { type: "boolean", description: "Analyze a Vite app via an in-process build (auto-detected)" },
} as const;

async function loadGraphFromArgs(args: {
  cwd: string;
  "analyze-export"?: string;
  "dist-dir"?: string;
  snapshot?: string;
  analyze: boolean;
  vite?: boolean;
}): Promise<ParsedGraph> {
  const projectRoot = resolve(args.cwd);
  const snapshot = args.snapshot ?? (args.analyze ? "wins" : undefined);
  const vite = args.vite ?? isViteProject(projectRoot);
  if (!vite && args.analyze && !args["analyze-export"]) await runNextAnalyze(projectRoot, snapshot!);
  return loadGraph({
    projectRoot,
    analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : undefined,
    distDir: args["dist-dir"],
    snapshot,
    vite,
    analyzed: args.analyze,
  });
}

const packagesCommand = defineCommand({
  meta: { name: "packages", description: "Bytes by package in client first-load JS; --why <pkg> traces the import chains that pull a package in" },
  args: {
    ...graphArgs,
    top: { type: "string", description: "Number of packages to print", default: "25" },
    route: { type: "string", description: "Only routes containing this substring" },
    why: { type: "string", description: "Explain why this package/file is in first-load JS (same as `wimb why <pkg>`)" },
    "all-routes": { type: "boolean", description: "With --why: list every route that includes the target", default: false },
    chains: { type: "string", description: "With --why: max distinct import chains per route", default: "3" },
    json: { type: "boolean", description: "Print JSON", default: false },
  },
  async run({ args }) {
    let exitCode = 0;
    try {
      const top = parseNumberFlag("top", args.top) ?? 25;
      const chains = parseNumberFlag("chains", args.chains) ?? 3;
      const graph = await loadGraphFromArgs(args);
      if (args.why) {
        const report = whyReport(graph, args.why, { route: args.route, allRoutes: args["all-routes"], chains });
        console.log(args.json ? JSON.stringify(report, null, 2) : formatWhy(report));
        exitCode = report.routes.length ? 0 : 1;
      } else {
        const rgs = [...graph.routes.keys()]
          .sort()
          .filter((r) => !args.route || r.includes(args.route))
          .map((r) => buildRouteGraph(graph, r))
          .filter((r): r is RouteGraph => !!r);
        const rows = packageTable(rgs, top);
        console.log(args.json ? JSON.stringify(rows, null, 2) : formatPackageTable(rows).join("\n"));
      }
    } catch (err) {
      return fail(err);
    }
    process.stdout.write("", () => process.exit(exitCode));
  },
});

const listFlag = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);

const verifyCommand = defineCommand({
  meta: { name: "verify", description: "Rebuild after an edit and compare with the baseline: per-route first-load/preloaded/on-demand deltas, keep-or-revert verdict" },
  args: {
    ...graphArgs,
    "min-bytes": { type: "string", description: "Drop edges saving fewer bytes than this" },
    baseline: { type: "string", description: "Baseline wins.json (default .wimb/wins.prev.json, falling back to .wimb/wins.json)" },
    init: { type: "boolean", description: "Take the baseline snapshot now (writes wins.json, wins.prev.json) and exit", default: false },
    win: { type: "string", description: "Win id to attribute this check to (verdict recorded in .wimb/verify.json)" },
    tolerance: { type: "string", description: "Bytes of first-load change treated as noise", default: "200" },
    revert: { type: "boolean", description: "On failure, `git checkout --` only the win's files (and --files)", default: false },
    files: { type: "string", description: "Extra file to revert on failure (repeatable, relative to --cwd)" },
    "force-revert": { type: "boolean", description: "Revert even files that had uncommitted changes before the win", default: false },
    accept: { type: "boolean", description: "On success, rotate the baseline (wins.json -> wins.prev.json)", default: false },
    json: { type: "boolean", description: "Print the verdict as JSON", default: false },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let exitCode = 0;
    try {
      const tolerance = parseNumberFlag("tolerance", args.tolerance) ?? 200;
      const minBytes = parseNumberFlag("min-bytes", args["min-bytes"]);
      const prevPath = resolve(projectRoot, args.baseline ?? join(".wimb", "wins.prev.json"));
      const fallback = wimbPath(projectRoot, "wins.json");
      let baseline: WinsReport | undefined;
      if (!args.init) {
        const file = existsSync(prevPath) ? prevPath : !args.baseline && existsSync(fallback) ? fallback : null;
        if (!file) throw new FlagError(`no baseline at ${prevPath}; run \`wimb verify --init\` before editing`);
        baseline = validateWinsReport(JSON.parse(readFileSync(file, "utf-8")), file);
      }
      const snapshot = args.snapshot ?? (args.analyze ? "wins" : undefined);
      const vite = args.vite ?? isViteProject(projectRoot);
      if (!vite && args.analyze && !args["analyze-export"]) await runNextAnalyze(projectRoot, snapshot!);
      const report = await runWins({
        projectRoot,
        analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : undefined,
        distDir: args["dist-dir"],
        snapshot,
        vite,
        minBytes,
        analyzed: args.analyze,
      });
      writeWins(projectRoot, report);
      if (args.init || !baseline) {
        acceptBaseline(projectRoot);
        snapshotFileState(projectRoot, report);
        console.log(`wimb: baseline saved (${report.routes.length} routes, ${report.wins.length} wins) -> .wimb/wins.prev.json`);
      } else {
        const win = args.win ? baseline.wins.find((w) => w.id === args.win) : undefined;
        if (args.win && !win) throw new FlagError(`win ${args.win} not found in the baseline`);
        const v = judge(baseline, report, { tolerance, win });
        const sign = (n: number) => `${n >= 0 ? "+" : ""}${(n / 1024).toFixed(1)} KB`;
        if (args.json) console.log(JSON.stringify({ winId: args.win ?? null, status: v.status, reason: v.reason, deltas: v.deltas }, null, 2));
        else {
          for (const d of v.deltas) console.log(`  ${d.route}  first-load ${sign(d.firstLoad)}  preloaded ${sign(d.preloaded)}  on-demand ${sign(d.onDemand)}`);
          console.log(`wimb verify: ${v.status}${args.win ? ` (${args.win})` : ""}: ${v.reason}`);
        }
        if (args.win) recordVerify(projectRoot, { winId: args.win, status: v.status, deltas: v.deltas, reason: v.reason, timestamp: new Date().toISOString() });
        if (v.status === "failed") {
          exitCode = 1;
          if (args.revert) {
            const files = [...winFiles(win), ...listFlag(args.files)];
            if (files.length === 0) console.error("wimb verify: --revert needs --win <id> or --files <path>; nothing reverted");
            else {
              const plan = planRevert(projectRoot, files, args["force-revert"]);
              for (const r of plan.refused) console.error(`wimb verify: refusing to revert ${r.file}: ${r.why}`);
              console.error(plan.revert.length ? `wimb verify: reverting (git checkout --) ${plan.revert.join(", ")}` : "wimb verify: nothing to revert");
              applyRevert(projectRoot, plan);
              if (plan.revert.length) console.error("wimb verify: rebuild before the next check; the baseline is unchanged");
            }
          }
        } else if (args.accept) {
          acceptBaseline(projectRoot);
          snapshotFileState(projectRoot, report);
          console.error("wimb verify: baseline rotated (.wimb/wins.json -> .wimb/wins.prev.json)");
        }
      }
    } catch (err) {
      return fail(err);
    }
    process.stdout.write("", () => process.exit(exitCode));
  },
});

const winsCommand = defineCommand({
  meta: { name: "wins", description: "Rank import edges whose removal shrinks first-load client JS" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    "analyze-export": { type: "string", description: "next analyze export JSONL (.jsonl or .jsonl.gz)" },
    "dist-dir": { type: "string", description: "distDir with diagnostics/analyze (default .next)" },
    snapshot: { type: "string", description: "Named next analyze snapshot" },
    analyze: { type: "boolean", description: "Run `next analyze --output` first (use --no-analyze to reuse existing data)", default: true },
    vite: { type: "boolean", description: "Analyze a Vite app via an in-process build (auto-detected when vite is a dependency and next is not)" },
    "min-bytes": { type: "string", description: "Drop edges saving fewer bytes than this" },
    top: { type: "string", description: "Number of wins to print", default: "10" },
    json: { type: "boolean", description: "Print WinsReport JSON to stdout", default: false },
    packages: { type: "boolean", description: "Print the node_modules package table (top 25 in client first-load)", default: false },
    compare: { type: "string", description: "Previous wins.json to compare against" },
    "budget-route": { type: "string", description: "Fail if any route first-load exceeds this many bytes" },
    "fail-on-safe-wins": { type: "string", description: "Fail if safe wins exceed this many bytes" },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let report: WinsReport;
    let prev: WinsReport | undefined;
    let graph: ParsedGraph | undefined;
    let minBytes: number | undefined;
    let routeBudgetBytes: number | undefined;
    let maxSafeWinBytes: number | undefined;
    let top = 10;
    try {
      minBytes = parseNumberFlag("min-bytes", args["min-bytes"]);
      routeBudgetBytes = parseNumberFlag("budget-route", args["budget-route"]);
      maxSafeWinBytes = parseNumberFlag("fail-on-safe-wins", args["fail-on-safe-wins"]);
      top = parseNumberFlag("top", args.top) ?? 10;
      if (args.compare) {
        const file = resolve(projectRoot, args.compare);
        let data: unknown;
        try {
          data = JSON.parse(readFileSync(file, "utf-8"));
        } catch (e) {
          throw new FlagError(`cannot read --compare file ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
        prev = validateWinsReport(data, file);
      }
    } catch (err) {
      return fail(err);
    }
    try {
      const snapshot = args.snapshot ?? (args.analyze ? "wins" : undefined);
      const vite = args.vite ?? isViteProject(projectRoot);
      if (!vite && args.analyze && !args["analyze-export"]) await runNextAnalyze(projectRoot, snapshot!);
      report = await runWins({
        onGraph: (g) => (graph = g),
        projectRoot,
        analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : undefined,
        distDir: args["dist-dir"],
        snapshot,
        vite,
        minBytes,
        analyzed: args.analyze,
      });
    } catch (err) {
      return fail(err);
    }
    const { jsonPath, mdPath } = writeWins(projectRoot, report);
    const vizPath = join(dirname(jsonPath), "bundle-graph.json");
    try {
      if (graph) writeVizFile(vizPath, buildDualRouteForest(graph));
      else await writeVizGraph({ projectRoot, distDir: args["dist-dir"], outputPath: vizPath });
    } catch (err) {
      console.error(`wimb: skipped bundle-graph.json: ${(err as Error).message}`);
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(formatWinsTerminal(report, { top, packages: args.packages }));
      console.log(`\nwimb: wrote ${jsonPath}, ${mdPath} and ${vizPath}`);
    }
    if (prev) {
      const cmp = compareWins(prev, report);
      console.error("wimb: first-load delta vs previous");
      for (const r of cmp.routes)
        console.error(
          `  ${r.route}  ${r.delta >= 0 ? "+" : ""}${(r.delta / 1024).toFixed(1)} KB` +
            (r.preloadedDelta !== undefined ? `  (preloaded ${r.preloadedDelta >= 0 ? "+" : ""}${(r.preloadedDelta / 1024).toFixed(1)} KB)` : ""),
        );
      console.error(`  wins resolved: ${cmp.resolved.length}, new: ${cmp.introduced.length}`);
    }
    const violations = checkBudget(report, { routeBudgetBytes, maxSafeWinBytes });
    for (const v of violations) console.error(`wimb: ${v.message}`);
    const exitCode = violations.length ? 1 : 0;
    process.stdout.write("", () => process.exit(exitCode));
  },
});

const auditCommand = defineCommand({
  meta: { name: "audit", description: "Static, build-free whole-site performance audit (Next.js App Router / CMS apps)" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    json: { type: "boolean", description: "Print audit JSON to stdout", default: false },
    top: { type: "string", description: "Findings per check in audit.md / terminal", default: "10" },
    checks: { type: "string", description: "Comma-separated subset of checks to run" },
    "fail-on": { type: "string", description: "Exit 1 if any finding at or above this severity (high|medium)" },
    fix: { type: "boolean", description: "Apply safe mechanical autofixes (scripts, font display, ssr:false, image formats, hero priority, raw img lazy)", default: false },
    "fix-dry-run": { type: "boolean", description: "Print a unified diff of the autofixes without writing", default: false },
    force: { type: "boolean", description: "With --fix: also edit files that have unstaged git changes", default: false },
    baseline: { type: "string", description: "Baseline file: only NEW findings are reported and counted by --fail-on" },
    "save-baseline": { type: "boolean", description: "Write current findings to the --baseline file (default .wimb/audit-baseline.json) and exit 0", default: false },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let checks, failOn, top;
    try {
      checks = parseAuditChecks(args.checks);
      failOn = parseFailOn(args["fail-on"]);
      top = parseTop(args.top, 10);
    } catch (err) {
      return fail(err);
    }
    const config = await loadConfig(projectRoot);
    const log = args.json ? console.error : console.log;
    const base = { projectRoot, checks, ignoreFiles: config.ignores.files, ignoreRules: config.ignores.rules, thresholds: config.thresholds };
    const baselinePath = args.baseline ? resolve(projectRoot, args.baseline) : undefined;
    if (args["save-baseline"]) {
      const target = baselinePath ?? resolve(projectRoot, ".wimb", "audit-baseline.json");
      const { findings } = collectFindings(base);
      writeBaseline(target, makeBaseline(findings));
      log(`wimb audit: saved baseline of ${findings.length} finding(s) to ${target}`);
      return;
    }
    if (args.fix || args["fix-dry-run"]) {
      const { findings } = collectFindings(base);
      const dryRun = !!args["fix-dry-run"];
      const res = applyFixes(projectRoot, findings, { dryRun, force: args.force });
      if (dryRun && res.diff) (args.json ? process.stderr : process.stdout).write(res.diff);
      log(formatFixSummary(res, dryRun));
    }
    let baseline;
    try {
      baseline = baselinePath ? readBaseline(baselinePath) : undefined;
    } catch (err) {
      return fail(err);
    }
    const report = runAudit({ ...base, baseline });
    const paths = writeAudit(projectRoot, report, top);
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    log(formatAuditTerminal(report, top));
    log(`  wrote ${paths.md} and ${paths.json}`);
    const bad = failOn === "high" ? report.summary.high : failOn === "medium" ? report.summary.high + report.summary.medium : 0;
    process.stdout.write("", () => process.exit(bad > 0 ? 1 : 0));
  },
});

const openCommand = defineCommand({
  meta: { name: "open", description: "Open the visualizer in a browser pre-loaded with .wimb/ data (no file picking)" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    url: { type: "string", description: "Visualizer base URL", default: DEFAULT_VISUALIZER_URL },
    "no-launch": { type: "boolean", description: "Print the URL instead of opening a browser", default: false },
  },
  async run({ args }) {
    try {
      const gz = buildPayload(resolve(args.cwd));
      const inline = inlineUrl(args.url, gz);
      if (inline) {
        console.log(inline.length > 2000 ? `wimb: opening visualizer (${(inline.length / 1024).toFixed(0)} KB link)` : `wimb: ${inline}`);
        if (!args["no-launch"]) launchBrowser(inline);
        return;
      }
      await serveOnce(gz, args.url, (url) => {
        console.log(`wimb: serving data on localhost until the page loads it (2 min max)\nwimb: ${url}`);
        if (!args["no-launch"]) launchBrowser(url);
      });
    } catch (err) {
      fail(err);
    }
  },
});

const speedCommand = defineCommand({
  meta: { name: "speed", description: "One command: audit + wins (+ live) merged into a prioritized plan (.wimb/plan.{json,md})" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    url: { type: "string", description: "Live URL(s) to audit; repeatable or comma-separated" },
    "urls-file": { type: "string", description: "File with one URL per line (live audit)" },
    sitemap: { type: "string", description: "Sitemap URL for the live audit" },
    sample: { type: "string", description: "Sample N URLs from the sitemap / URL list" },
    wins: { type: "boolean", description: "Run `wimb wins` (use --no-wins to skip)", default: true },
    live: { type: "boolean", description: "Run the live audit when URLs are given (use --no-live to skip)", default: true },
    analyze: { type: "boolean", description: "Pass --no-analyze through to wins to reuse existing analyze data", default: true },
    top: { type: "string", description: "Items per section in terminal / Do first", default: "10" },
    json: { type: "boolean", description: "Print plan JSON to stdout", default: false },
    prompt: { type: "boolean", description: "Print only the agent handoff prompt to stdout", default: false },
    compare: { type: "boolean", description: "Show resolved/new/regressed vs .wimb/plan.prev.json", default: false },
    snapshot: { type: "boolean", description: "Copy plan.json to plan.prev.json after the run", default: false },
    "fail-on": { type: "string", description: "Exit 1 if any plan item at or above this severity (high|medium)" },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let opts;
    try {
      const rawUrls = [...(Array.isArray(args.url) ? args.url : [args.url])];
      opts = {
        projectRoot,
        urls: parseUrlFlag(rawUrls),
        urlsFile: args["urls-file"],
        sitemap: args.sitemap,
        sample: parseSample(args.sample),
        wins: args.wins,
        live: args.live,
        analyze: args.analyze,
        top: parseTop(args.top, 10),
        compare: args.compare,
        snapshot: args.snapshot,
        failOn: parseFailOn(args["fail-on"]),
      };
    } catch (err) {
      return fail(err);
    }
    let result;
    try {
      result = await runSpeed(opts);
    } catch (err) {
      return fail(err);
    }
    const quiet = args.json || args.prompt;
    const log = quiet ? console.error : console.log;
    if (args.prompt) process.stdout.write(result.plan.agentPrompt);
    else if (args.json) process.stdout.write(JSON.stringify(result.plan, null, 2) + "\n");
    log(result.terminal);
    log(`  wrote ${result.paths.md} and ${result.paths.json}`);
    process.stdout.write("", () => process.exit(result.exitCode));
  },
});

const liveCommand = defineCommand({
  meta: { name: "live", description: "Runtime audit of deployed pages (HTML, headers, scripts, GTM, images) over plain HTTP" },
  args: {
    "urls-file": { type: "string", description: "File with one URL per line" },
    sitemap: { type: "string", description: "Sitemap URL; samples --sample URLs across path patterns" },
    sample: { type: "string", description: "URLs to sample from the sitemap", default: "8" },
    concurrency: { type: "string", description: "Parallel page fetches", default: "3" },
    timeout: { type: "string", description: "Per-request timeout in ms", default: "15000" },
    "user-agent": { type: "string", description: "User-Agent header" },
    mobile: { type: "boolean", description: "Use a mobile User-Agent", default: false },
    "max-requests": { type: "string", description: "Total request cap", default: "150" },
    out: { type: "string", description: "Output directory", default: ".wimb" },
    json: { type: "boolean", description: "Print JSON to stdout", default: false },
    "fail-on": { type: "string", description: "Exit 1 on findings at or above high|medium" },
    lighthouse: { type: "boolean", description: "Run Lighthouse via npx --no-install (first 3 pages)", default: false },
    "lighthouse-json": { type: "string", description: "Import existing Lighthouse JSON report(s); extra .json args are also imported" },
  },
  async run({ args }) {
    try {
      const pos = ((args as any)._ as string[] | undefined) ?? [];
      const lhArg = args["lighthouse-json"] as unknown;
      const lhJson = ([] as string[]).concat((lhArg as string | string[] | undefined) ?? [], pos.filter((x) => /\.json$/i.test(x)));
      const urls = pos.filter((x) => !/\.json$/i.test(x));
      const failOn = parseFailOn(args["fail-on"]);
      const int = (n: string, v: string | undefined, d: number) => {
        const x = parseNumberFlag(n, v);
        return x === undefined ? d : Math.max(1, Math.floor(x));
      };
      if (!urls.length && !args["urls-file"] && !args.sitemap && !lhJson.length) {
        throw new FlagError("usage: wimb live <url...> [--urls-file f] [--sitemap url]");
      }
      const report = await runLive({
        urls,
        urlsFile: args["urls-file"],
        sitemap: args.sitemap,
        sample: int("sample", args.sample, 8),
        concurrency: int("concurrency", args.concurrency, 3),
        timeoutMs: int("timeout", args.timeout, 15000),
        userAgent: args["user-agent"] ?? (args.mobile ? MOBILE_UA : DEFAULT_UA),
        mobile: args.mobile,
        maxRequests: int("max-requests", args["max-requests"], 150),
        out: args.out,
        json: args.json,
        failOn,
        lighthouse: args.lighthouse,
        lighthouseJson: lhJson,
      });
      writeLive(report, args.out);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatTerminal(report, args.out));
      if (failOn && report.findings.some((f) => f.severity === "high" || (failOn === "medium" && f.severity === "medium"))) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  },
});

const validateCommand = defineCommand({
  meta: { name: "validate", description: "Compare wins.json route sizes against scripts in prerendered HTML (or a live URL)" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    wins: { type: "string", description: "Path to wins.json (default .wimb/wins.json)" },
    "dist-dir": { type: "string", description: "distDir (default .next)" },
    "html-dir": { type: "string", description: "Directory of exported HTML files" },
    url: { type: "string", description: "Base URL to fetch route HTML and chunks from" },
    tolerance: { type: "string", description: "Allowed diff, fraction (0.15) or percent (15)", default: "0.15" },
    strict: { type: "boolean", description: "Exit 1 if any route is flagged", default: false },
    json: { type: "boolean", description: "Print ValidationReport JSON to stdout", default: false },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    let report: WinsReport;
    let tolerance = 0.15;
    try {
      const file = resolve(projectRoot, args.wins ?? join(".wimb", "wins.json"));
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new FlagError(`cannot read ${file}; run \`wimb wins\` first`);
      }
      report = validateWinsReport(data, file);
      const t = parseNumberFlag("tolerance", args.tolerance);
      if (t !== undefined) tolerance = t > 1 ? t / 100 : t;
    } catch (err) {
      return fail(err);
    }
    try {
      const result = await runValidate({
        projectRoot,
        distDir: args["dist-dir"],
        htmlDir: args["html-dir"] ? resolve(projectRoot, args["html-dir"]) : undefined,
        url: args.url,
        tolerance,
        report,
      });
      report.validation = result;
      writeWins(projectRoot, report);
      writeValidation(projectRoot, result);
      if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      console.log(formatValidationTerminal(result));
      const code = args.strict && result.flagged > 0 ? 1 : 0;
      process.stdout.write("", () => process.exit(code));
    } catch (err) {
      fail(err);
    }
  },
});

const main = defineCommand({
  meta: { name: "wimb", description: "Where Is My Banana — Next.js client bloat detector" },
  subCommands: { scan: scanCommand, viz: vizCommand, wins: winsCommand, why: whyCommand, packages: packagesCommand, verify: verifyCommand, audit: auditCommand, speed: speedCommand, open: openCommand, live: liveCommand, validate: validateCommand },
});

runMain(main);
