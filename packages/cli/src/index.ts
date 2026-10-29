#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { resolve } from "node:path";
import { scan } from "./scan.js";
import { writeVizGraph } from "./viz.js";
import { readFileSync } from "node:fs";
import { runWins, runNextAnalyze } from "./wins/index.js";
import { formatWinsTerminal, writeWins } from "./wins/output.js";
import { checkBudget, compareWins } from "./wins/compare.js";
import type { WinsReport } from "./wins/types.js";

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
    const formats = args.format.split(",").map((s) => s.trim());
    const code = await scan({
      projectRoot,
      build: args.build,
      distDir: args["dist-dir"],
      snapshot: args.snapshot,
      analyzeExportPath: args["analyze-export"]
        ? resolve(projectRoot, args["analyze-export"])
        : undefined,
      formats,
      exitThreshold: args["exit-threshold"] as "error" | "warning" | "info",
      forestCompact: args["forest-compact"] || args["no-ast"],
    });
    process.exit(code);
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
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    const outputPath = resolve(projectRoot, args.output);
    const analyzeExport = args["analyze-export"]
      ? resolve(projectRoot, args["analyze-export"] as string)
      : undefined;
    const viz = writeVizGraph({
      analyzeExportPath: analyzeExport,
      projectRoot,
      distDir: args["dist-dir"],
      outputPath,
      includeAsync: args.async,
      includeTraced: args.traced,
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
    try {
      const snapshot = args.snapshot ?? (args.analyze ? "wins" : undefined);
      if (args.analyze && !args["analyze-export"]) await runNextAnalyze(projectRoot, snapshot!);
      report = await runWins({
        projectRoot,
        analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : undefined,
        distDir: args["dist-dir"],
        snapshot,
        minBytes: args["min-bytes"] ? Number(args["min-bytes"]) : undefined,
      });
    } catch (err) {
      console.error(`wimb: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const { jsonPath, mdPath } = writeWins(projectRoot, report);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(formatWinsTerminal(report, { top: Number(args.top) || 10 }));
      console.log(`\nwimb: wrote ${jsonPath} and ${mdPath}`);
    }
    if (args.compare) {
      const prev = JSON.parse(readFileSync(resolve(projectRoot, args.compare), "utf-8")) as WinsReport;
      const cmp = compareWins(prev, report);
      console.error("wimb: first-load delta vs previous");
      for (const r of cmp.routes) console.error(`  ${r.route}  ${r.delta >= 0 ? "+" : ""}${(r.delta / 1024).toFixed(1)} KB`);
      console.error(`  wins resolved: ${cmp.resolved.length}, new: ${cmp.introduced.length}`);
    }
    const violations = checkBudget(report, {
      routeBudgetBytes: args["budget-route"] ? Number(args["budget-route"]) : undefined,
      maxSafeWinBytes: args["fail-on-safe-wins"] ? Number(args["fail-on-safe-wins"]) : undefined,
    });
    for (const v of violations) console.error(`wimb: ${v.message}`);
    process.exit(violations.length ? 1 : 0);
  },
});

const main = defineCommand({
  meta: { name: "wimb", description: "Where Is My Banana — Next.js client bloat detector" },
  subCommands: { scan: scanCommand, viz: vizCommand, wins: winsCommand },
});

runMain(main);
