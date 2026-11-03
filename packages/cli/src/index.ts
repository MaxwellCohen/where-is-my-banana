#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { dirname, join, resolve } from "node:path";
import { scan } from "./scan.js";
import { buildDualRouteForest } from "@wimb/graph-v1";
import type { ParsedGraph } from "@wimb/graph-v1";
import { writeVizGraph, writeVizFile } from "./viz.js";
import { readFileSync } from "node:fs";
import { FlagError, parseAuditChecks, parseExitThreshold, parseFailOn, parseFormats, parseNumberFlag, parseTop, validateWinsReport } from "./index-flags.js";
import { collectFindings, runAudit } from "./audit/index.js";
import { formatAuditTerminal, writeAudit } from "./audit/output.js";
import { applyFixes, formatFixSummary } from "./audit/fix.js";
import { makeBaseline, readBaseline, writeBaseline } from "./audit/baseline.js";
import { runLive, writeLive, formatTerminal } from "./live/index.js";
import { DEFAULT_UA, MOBILE_UA } from "./live/net.js";
import { loadConfig } from "./config.js";
import { DEFAULT_VISUALIZER_URL, buildPayload, inlineUrl, launchBrowser, serveOnce } from "./open.js";
import { runWins, runNextAnalyze } from "./wins/index.js";
import { isViteProject } from "./sources/vite.js";
import { formatWinsTerminal, writeWins } from "./wins/output.js";
import { checkBudget, compareWins } from "./wins/compare.js";
import type { WinsReport } from "./wins/types.js";
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
      console.log(formatWinsTerminal(report, { top }));
      console.log(`\nwimb: wrote ${jsonPath}, ${mdPath} and ${vizPath}`);
    }
    if (prev) {
      const cmp = compareWins(prev, report);
      console.error("wimb: first-load delta vs previous");
      for (const r of cmp.routes) console.error(`  ${r.route}  ${r.delta >= 0 ? "+" : ""}${(r.delta / 1024).toFixed(1)} KB`);
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
    const base = { projectRoot, checks, ignoreFiles: config.ignores.files, ignoreRules: config.ignores.rules };
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

const main = defineCommand({
  meta: { name: "wimb", description: "Where Is My Banana — Next.js client bloat detector" },
  subCommands: { scan: scanCommand, viz: vizCommand, wins: winsCommand, audit: auditCommand, speed: speedCommand, open: openCommand, live: liveCommand },
});

runMain(main);
