#!/usr/bin/env node
/**
 * Rebuild next-books (or WIMB_VIZ_SOURCE) into the visualizer demo graph.
 *
 *   pnpm viz:demo
 *   WIMB_VIZ_SOURCE=/path/to/app pnpm viz:demo
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(
  process.env.WIMB_VIZ_SOURCE ?? join(root, "../books-demo/next-books"),
);
const outJson = join(sourceRoot, ".wimb/bundle-graph.json");
const demoPath = join(root, "packages/visualizer/public/demo-graph.json");
const cli = join(root, "packages/cli/dist/index.js");

if (!existsSync(cli)) {
  console.error("CLI not built. Run: pnpm build");
  process.exit(1);
}

mkdirSync(dirname(outJson), { recursive: true });

const analyzeDir = join(sourceRoot, ".next/diagnostics/analyze");
const exportGz = join(sourceRoot, ".wimb/bundle-graph.jsonl.gz");

let args;
if (existsSync(exportGz)) {
  args = ["viz", "build", "--analyze-export", exportGz, "-o", outJson];
} else if (existsSync(analyzeDir)) {
  args = ["viz", "build", "--cwd", sourceRoot, "-o", outJson];
} else {
  console.error(
    `No analyze artifacts under ${sourceRoot}.\n` +
      `Run: pnpm exec next experimental-analyze --output\n` +
      `  (from that app), then re-run pnpm viz:demo`,
  );
  process.exit(1);
}

console.log(`$ node packages/cli/dist/index.js ${args.join(" ")}`);
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (!existsSync(outJson)) {
  console.error(`Expected ${outJson}`);
  process.exit(1);
}

mkdirSync(dirname(demoPath), { recursive: true });
cpSync(outJson, demoPath);
console.log(`Wrote ${demoPath}`);
console.log("Restart or soft-refresh http://localhost:3340");
