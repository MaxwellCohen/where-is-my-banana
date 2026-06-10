#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { resolve } from "node:path";
import { scan } from "./scan.js";

const scanCommand = defineCommand({
  meta: { name: "scan", description: "Scan a Next.js App Router project for client bloat" },
  args: {
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    build: { type: "boolean", description: "Deep scan with next experimental-analyze", default: false },
    "dist-dir": { type: "string", description: "Override distDir / point at pre-built analyze output" },
    format: { type: "string", description: "Output formats: json,md,sarif (comma-separated)", default: "json,md" },
    "exit-threshold": {
      type: "string",
      description: "Exit 1 if findings at or above this severity",
      default: "error",
    },
    e18e: { type: "boolean", description: "Merge @e18e/cli diagnostics", default: false },
  },
  async run({ args }) {
    const projectRoot = resolve(args.cwd);
    const formats = args.format.split(",").map((s) => s.trim());
    const code = await scan({
      projectRoot,
      build: args.build,
      distDir: args["dist-dir"],
      formats,
      exitThreshold: args["exit-threshold"] as "error" | "warning" | "info",
      e18e: args.e18e,
    });
    process.exit(code);
  },
});

const main = defineCommand({
  meta: { name: "wimb", description: "Where Is My Banana — Next.js client bloat detector" },
  subCommands: { scan: scanCommand },
});

runMain(main);
