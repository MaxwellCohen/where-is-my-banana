import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ByteAttribution } from "../types.js";
import {
  buildFullPaths,
  parseDataFile,
  readEdgesAtIndex,
  type AnalyzeRouteHeader,
  type ModulesHeader,
} from "./binary-format.js";
import { createExportAccumulator, parseAnalyzeExportFile } from "./analyze-export.js";
import { normalizeModulePath, packageNameFromPath } from "./module-path.js";

export { normalizeModulePath, packageNameFromPath };

/** Snapshot name wimb writes when it runs `next analyze` itself. */
const WIMB_SNAPSHOT = "wimb";

export interface BuildOptions {
  projectRoot: string;
  distDir?: string;
  /** Skip running next analyze; only parse existing artifacts or an export file. */
  skipBuild?: boolean;
  /** Named snapshot for `next analyze` / `next analyze export` (Next 16.4+). */
  snapshot?: string;
  /** Pre-exported `next analyze export` JSONL (`.jsonl` or `.jsonl.gz`). */
  analyzeExportPath?: string;
}

export function resolveDistDir(projectRoot: string, distDirName?: string, flag?: string): string {
  if (flag) return join(projectRoot, flag);
  return join(projectRoot, distDirName ?? ".next");
}

/** Locate analyze artifacts under distDir (binary data/ preferred). */
export function resolveAnalyzeDirs(distDir: string): {
  analyzeDir: string;
  dataDir: string | null;
} {
  const analyzeDir = join(distDir, "diagnostics", "analyze");
  const dataDir = join(analyzeDir, "data");
  return {
    analyzeDir,
    dataDir: existsSync(dataDir) ? dataDir : null,
  };
}

export function hasAnalyzeArtifacts(distDir: string): boolean {
  const { analyzeDir, dataDir } = resolveAnalyzeDirs(distDir);
  if (dataDir && (existsSync(join(dataDir, "modules.data")) || discoverRouteAnalyzeFiles(dataDir).length > 0)) {
    return true;
  }
  if (!existsSync(analyzeDir)) return false;
  // Legacy JSON format
  return readdirSync(analyzeDir).some((f) => f.endsWith(".json"));
}

export function projectSupportsAnalyzeExport(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "node_modules", "next", "analyze", "graph-v1.schema.json"));
}

export async function runBuildAnalysis(opts: BuildOptions): Promise<ByteAttribution | null> {
  if (opts.analyzeExportPath) {
    return readExportFile(opts.analyzeExportPath);
  }

  const distDir = opts.distDir ?? resolveDistDir(opts.projectRoot);
  const { analyzeDir, dataDir } = resolveAnalyzeDirs(distDir);
  const canExport = projectSupportsAnalyzeExport(opts.projectRoot);

  let capturedSnapshot: string | undefined;
  if (!opts.skipBuild && !hasAnalyzeArtifacts(distDir)) {
    capturedSnapshot = captureAnalyze(opts.projectRoot, canExport, opts.snapshot);
  }

  if (canExport) {
    const snapshot = opts.snapshot ?? capturedSnapshot;
    const exported = await exportAnalyzeGraph(opts.projectRoot, distDir, snapshot);
    if (exported && (exported.routes.size > 0 || exported.modules.size > 0)) {
      console.log("wimb: measured bytes from next analyze export");
      return exported;
    }
  }

  const resolvedDataDir = resolveAnalyzeDirs(distDir).dataDir;
  if (resolvedDataDir) {
    try {
      const attribution = parseBinaryAnalyzeDir(resolvedDataDir);
      if (attribution.routes.size > 0 || attribution.modules.size > 0) {
        console.log("wimb: measured bytes from binary analyze artifacts");
        return attribution;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`wimb: failed to parse binary analyze data (${message}); trying legacy formats`);
    }
  }

  if (existsSync(analyzeDir)) {
    const legacy = parseLegacyJsonAnalyzeDir(analyzeDir);
    if (legacy.routes.size > 0 || legacy.modules.size > 0) {
      console.log("wimb: measured bytes from legacy JSON analyze files");
      return legacy;
    }
  }

  const statsPath = join(distDir, "server", "webpack-stats.json");
  if (existsSync(statsPath)) {
    console.log("wimb: measured bytes from webpack stats");
    return parseWebpackStats(statsPath);
  }

  console.error(
    `wimb: analyze artifacts not found at ${dataDir ?? analyzeDir}. Run 'next analyze --output' (Next 16.4+) or 'next experimental-analyze --output', or pass --analyze-export.`,
  );
  return null;
}

function readExportFile(filePath: string): ByteAttribution | null {
  if (!existsSync(filePath)) {
    console.error(`wimb: analyze export not found at ${filePath}`);
    return null;
  }
  const attribution = parseAnalyzeExportFile(filePath);
  if (attribution.routes.size === 0 && attribution.modules.size === 0) {
    console.error(`wimb: no part records in ${filePath}`);
    return null;
  }
  console.log("wimb: measured bytes from next analyze export");
  return attribution;
}

/** Returns the snapshot name written by this capture, when Next 16.4+ was used. */
function captureAnalyze(
  projectRoot: string,
  canExport: boolean,
  snapshot: string | undefined,
): string | undefined {
  const name = canExport ? (snapshot ?? WIMB_SNAPSHOT) : undefined;
  const args = canExport
    ? ["analyze", "--output", "--snapshot", name!]
    : ["experimental-analyze", "--output"];
  try {
    const { command, args: fullArgs } = nextCommand(projectRoot, args);
    execFileSync(command, fullArgs, {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, TURBOPACK: "1", TURBOPACK_STATS: "1" },
    });
    return name;
  } catch {
    return undefined;
  }
}

function exportAnalyzeGraph(
  projectRoot: string,
  distDir: string,
  snapshot: string | undefined,
): Promise<ByteAttribution | null> {
  const args = ["analyze", "export", "--dist-dir", distDir];
  if (snapshot) args.push("--snapshot", snapshot);
  const { command, args: fullArgs } = nextCommand(projectRoot, args);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ByteAttribution | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(command, fullArgs, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TURBOPACK: "1" },
    });
    const acc = createExportAccumulator();
    let pending = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        acc.addLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-4_000);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (pending) acc.addLine(pending);
      if (code !== 0) {
        const tail = stderr.trim();
        if (tail) {
          console.error(`wimb: next analyze export failed; falling back to on-disk artifacts\n${tail}`);
        }
        finish(null);
        return;
      }
      finish(acc.finish());
    });
  });
}

function nextCommand(projectRoot: string, args: string[]): { command: string; args: string[] } {
  const local = join(projectRoot, "node_modules", ".bin", "next");
  if (existsSync(local)) return { command: local, args };
  return { command: "npx", args: ["next", ...args] };
}

/**
 * Parse Next.js Turbopack binary analyze output under `.next/diagnostics/analyze/data/`.
 */
export function parseBinaryAnalyzeDir(dataDir: string): ByteAttribution {
  const routes = new Map<string, number>();
  const modules = new Map<string, number>();

  const modulesPath = join(dataDir, "modules.data");
  if (existsSync(modulesPath)) {
    try {
      const { header } = parseDataFile<ModulesHeader>(readFileSync(modulesPath));
      for (const mod of header.modules ?? []) {
        const path = normalizeModulePath(mod.path ?? mod.ident ?? "");
        if (path && !modules.has(path)) modules.set(path, 0);
      }
    } catch {
      // modules.data is optional for size attribution
    }
  }

  const routeFiles = discoverRouteAnalyzeFiles(dataDir);
  for (const { route, filePath } of routeFiles) {
    try {
      const { header, binary } = parseDataFile<AnalyzeRouteHeader>(readFileSync(filePath));
      const attribution = attributeRoute(header, binary);
      routes.set(route, attribution.routeCompressedBytes || attribution.routeBytes);

      for (const [path, bytes] of attribution.modules) {
        const prev = modules.get(path) ?? 0;
        // Keep max across routes — same module may appear in multiple routes
        if (bytes > prev) modules.set(path, bytes);
      }
    } catch {
      // skip malformed route files
    }
  }

  // Also honor routes.json when present (may list routes without walking)
  const routesJson = join(dataDir, "routes.json");
  if (existsSync(routesJson)) {
    try {
      const listed = JSON.parse(readFileSync(routesJson, "utf-8")) as string[];
      for (const route of listed) {
        if (!routes.has(route)) routes.set(route, 0);
      }
    } catch {
      // ignore
    }
  }

  return { routes, modules, measured: true, format: "binary" };
}

function attributeRoute(
  header: AnalyzeRouteHeader,
  binary: DataView,
): { routeBytes: number; routeCompressedBytes: number; modules: Map<string, number> } {
  const sources = header.sources ?? [];
  const chunkParts = header.chunk_parts ?? [];
  const outputFiles = header.output_files ?? [];
  const fullPaths = buildFullPaths(sources);
  const modules = new Map<string, number>();

  let routeBytes = 0;
  let routeCompressedBytes = 0;

  for (let i = 0; i < sources.length; i++) {
    const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
    if (partIndices.length === 0) continue;

    let size = 0;
    let compressed = 0;
    let clientSize = 0;
    let clientCompressed = 0;

    for (const cpIdx of partIndices) {
      const cp = chunkParts[cpIdx];
      if (!cp) continue;
      size += cp.size;
      compressed += cp.compressed_size;
      const of = outputFiles[cp.output_file_index];
      if (of?.filename.startsWith("[client-fs]/") && of.filename.endsWith(".js")) {
        clientSize += cp.size;
        clientCompressed += cp.compressed_size;
      }
    }

    // Route totals include all output; module map is client JS only
    routeBytes += size;
    routeCompressedBytes += compressed;

    if (clientSize === 0 && clientCompressed === 0) continue;

    const rawPath = fullPaths[i] ?? sources[i]?.path ?? "";
    const path = normalizeModulePath(rawPath);
    if (!path) continue;

    const bytes = clientCompressed > 0 ? clientCompressed : clientSize;
    modules.set(path, (modules.get(path) ?? 0) + bytes);

    const pkg = packageNameFromPath(path);
    if (pkg) {
      modules.set(pkg, (modules.get(pkg) ?? 0) + bytes);
    }
  }

  // If no client flags were found (older/simpler fixtures), fall back to all sources with sizes
  if (modules.size === 0) {
    for (let i = 0; i < sources.length; i++) {
      const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
      if (partIndices.length === 0) continue;
      let size = 0;
      let compressed = 0;
      for (const cpIdx of partIndices) {
        const cp = chunkParts[cpIdx];
        if (!cp) continue;
        size += cp.size;
        compressed += cp.compressed_size;
      }
      const path = normalizeModulePath(fullPaths[i] ?? "");
      if (!path) continue;
      const bytes = compressed > 0 ? compressed : size;
      modules.set(path, (modules.get(path) ?? 0) + bytes);
      const pkg = packageNameFromPath(path);
      if (pkg) modules.set(pkg, (modules.get(pkg) ?? 0) + bytes);
    }
  }

  return { routeBytes, routeCompressedBytes, modules };
}

export function discoverRouteAnalyzeFiles(
  dataDir: string,
): { route: string; filePath: string }[] {
  const routes: { route: string; filePath: string }[] = [];

  function walk(dir: string, routePrefix: string): void {
    const analyzeFile = join(dir, "analyze.data");
    if (existsSync(analyzeFile)) {
      routes.push({ route: routePrefix || "/", filePath: analyzeFile });
    }
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "analyze.data" || entry === "modules.data" || entry === "routes.json") continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          walk(full, `${routePrefix}/${entry}`.replace(/\/+/g, "/") || "/");
        }
      } catch {
        // skip
      }
    }
  }

  walk(dataDir, "");
  return routes;
}

function parseLegacyJsonAnalyzeDir(dir: string): ByteAttribution {
  const routes = new Map<string, number>();
  const modules = new Map<string, number>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
        route?: string;
        size?: number;
        modules?: { name: string; size: number }[];
      };
      if (data.route && data.size) routes.set(data.route, data.size);
      if (data.modules) {
        for (const m of data.modules) modules.set(m.name, m.size);
      }
    } catch {
      // skip malformed
    }
  }

  return { routes, modules, measured: true, format: "legacy-json" };
}

function parseWebpackStats(path: string): ByteAttribution {
  const routes = new Map<string, number>();
  const modules = new Map<string, number>();
  try {
    const stats = JSON.parse(readFileSync(path, "utf-8")) as {
      chunks?: { names?: string[]; size?: number }[];
      modules?: { name?: string; size?: number }[];
    };
    for (const chunk of stats.chunks ?? []) {
      const name = chunk.names?.[0] ?? "unknown";
      routes.set(name, (routes.get(name) ?? 0) + (chunk.size ?? 0));
    }
    for (const mod of stats.modules ?? []) {
      if (mod.name) modules.set(mod.name, mod.size ?? 0);
    }
  } catch {
    // ignore
  }
  return { routes, modules, measured: true, format: "webpack-stats" };
}
