#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { resolve } from "node:path";
import { scan } from "./scan.js";
import { loadConfig } from "./config.js";
import {
  compareReports,
  exitCodeForDiff,
  loadReport,
  writeDiffReport,
  toDiffMarkdown,
} from "./diff.js";
import { writeVizGraph } from "./viz.js";

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
      description: "Output formats: json,md,sarif (comma-separated)",
      default: "json,md",
    },
    "exit-threshold": {
      type: "string",
      description: "Exit 1 if findings at or above this severity",
      default: "error",
    },
    e18e: { type: "boolean", description: "Merge @e18e/cli diagnostics", default: false },
    "rsc-xray": {
      type: "boolean",
      description: "Merge @rsc-xray/analyzer diagnostics (opt-in)",
      default: false,
    },
    baseline: {
      type: "string",
      description: "Compare against a prior wimb-report.json and write wimb-diff.*",
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
      e18e: args.e18e,
      rscXray: args["rsc-xray"],
      baseline: args.baseline,
      forestCompact: args["forest-compact"] || args["no-ast"],
    });
    process.exit(code);
  },
});

const diffCommand = defineCommand({
  meta: {
    name: "diff",
    description: "Compare two wimb-report.json files (baseline vs current)",
  },
  args: {
    baseline: { type: "positional", description: "Path to baseline wimb-report.json", required: true },
    current: { type: "positional", description: "Path to current wimb-report.json", required: true },
    cwd: {
      type: "string",
      description: "Project root for writing wimb-diff.* (defaults to cwd)",
      default: process.cwd(),
    },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    const config = await loadConfig(projectRoot);
    const baseline = loadReport(resolve(args.baseline as string));
    const current = loadReport(resolve(args.current as string));
    const diff = compareReports(baseline, current, config);
    writeDiffReport(projectRoot, diff);
    console.log(toDiffMarkdown(diff));
    process.exit(exitCodeForDiff(diff, config));
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

const main = defineCommand({
  meta: { name: "wimb", description: "Where Is My Banana — Next.js client bloat detector" },
  subCommands: { scan: scanCommand, diff: diffCommand, viz: vizCommand },
});

runMain(main);
